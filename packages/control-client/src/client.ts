/**
 * A dependency-free, typed client for the Gulley control API. Mirrors the
 * published OpenAPI document (`./openapi`). Every method sends the admin bearer
 * token and returns parsed JSON; a non-2xx throws {@link ControlApiError}.
 */

export type CollectionName =
  'routes' | 'policies' | 'budgets' | 'rate-limits' | 'guardrails' | 'model-aliases';

export interface ControlClientOptions {
  baseUrl: string;
  /** Admin session (gses_) or bootstrap (gadm_) token. */
  token: string;
  /** Injected fetch (tests / non-global runtimes); defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-call deadline (ms). Default 15 s; 0 disables. */
  timeoutMs?: number;
}

/** A non-2xx answer. `body` is the parsed JSON, or `{ raw }` when it was not JSON
 *  (a proxy's HTML error page, an empty 502), and `type`/`requestId` are lifted from
 *  the API's `{ error: { type, message, requestId } }` envelope when present. */
export class ControlApiError extends Error {
  readonly type: string | undefined;
  readonly requestId: string | undefined;
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const env =
      body && typeof body === 'object' && (body as { error?: unknown }).error
        ? ((body as { error?: unknown }).error as Record<string, unknown>)
        : undefined;
    const message = env && typeof env['message'] === 'string' ? env['message'] : undefined;
    super(`control API ${status}${message ? `: ${message}` : ''}`);
    this.name = 'ControlApiError';
    this.type = env && typeof env['type'] === 'string' ? env['type'] : undefined;
    this.requestId = env && typeof env['requestId'] === 'string' ? env['requestId'] : undefined;
  }
}

/** The request never got an HTTP answer: DNS/connect failure, or the deadline. */
export class ControlNetworkError extends Error {
  constructor(
    message: string,
    readonly timeout: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ControlNetworkError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface Org {
  id: string;
  name: string;
  createdAt: string;
}
export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
}
export interface ScopedEntity {
  id: string;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
}
export interface MintedKey {
  id: string;
  token: string;
  keyPrefix: string;
}
export interface PromptVersionView {
  version: number;
  body: string;
  variables: string[];
  hash: string;
  prevHash: string | null;
  createdAt: string;
  createdBy: string;
  message?: string;
}
export interface PromptTemplateView {
  id: string;
  workspaceId: string;
  name: string;
  versions: PromptVersionView[];
}
export interface PromptSummaryView {
  id: string;
  workspaceId: string;
  name: string;
  latestVersion: number;
  headHash: string;
  updatedAt: string;
}
export interface ChainVerificationView {
  verified: boolean;
  count: number;
  brokenAt?: number;
}

export class ControlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ControlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    const injected = opts.fetch ?? globalThis.fetch;
    if (!injected) throw new Error('no fetch available; pass options.fetch');
    this.f = injected;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const hasBody = body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
      });
    } catch (err) {
      const timeout = (err as { name?: string }).name === 'TimeoutError';
      throw new ControlNetworkError(
        timeout
          ? `control API ${method} ${path} timed out after ${this.timeoutMs} ms`
          : `control API ${method} ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        timeout,
        err,
      );
    }
    const text = await res.text();
    let json: unknown;
    let parsed = true;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      parsed = false;
      json = { raw: text.slice(0, 2_000) };
    }
    // A non-JSON body is never surfaced as a SyntaxError: the status is the signal.
    if (!res.ok) throw new ControlApiError(res.status, json);
    if (!parsed) throw new ControlApiError(res.status, json);
    return json as T;
  }

  // --- tenancy ---
  listOrgs(): Promise<{ orgs: Org[] }> {
    return this.req('GET', '/orgs');
  }
  createOrg(name: string): Promise<{ org: Org }> {
    return this.req('POST', '/orgs', { name });
  }
  deleteOrg(id: string): Promise<{ deleted: boolean }> {
    return this.req('DELETE', `/orgs/${encodeURIComponent(id)}`);
  }
  listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.req('GET', '/workspaces');
  }
  createWorkspace(orgId: string, name: string): Promise<{ workspace: Workspace }> {
    return this.req('POST', '/workspaces', { orgId, name });
  }
  deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
    return this.req('DELETE', `/workspaces/${encodeURIComponent(id)}`);
  }

  // --- providers ---
  listProviders(): Promise<{ providers: unknown[] }> {
    return this.req('GET', '/providers');
  }
  createProvider(input: {
    workspaceId: string;
    kind: string;
    baseUrl?: string;
  }): Promise<{ provider: { id: string } }> {
    return this.req('POST', '/providers', input);
  }
  deleteProvider(id: string): Promise<{ deleted: boolean }> {
    return this.req('DELETE', `/providers/${encodeURIComponent(id)}`);
  }
  setProviderCredential(
    id: string,
    ref: { secretArn: string; secretVersion: string },
  ): Promise<{ credential: unknown }> {
    return this.req('POST', `/providers/${encodeURIComponent(id)}/credential`, ref);
  }

  // --- virtual keys ---
  mintKey(input: { workspaceId: string; name?: string }): Promise<MintedKey> {
    return this.req('POST', '/keys', input);
  }
  getKey(id: string): Promise<{ key: unknown }> {
    return this.req('GET', `/keys/${encodeURIComponent(id)}`);
  }
  listKeys(workspaceId: string): Promise<{ keys: unknown[] }> {
    return this.req('GET', `/keys?workspaceId=${encodeURIComponent(workspaceId)}`);
  }
  disableKey(id: string): Promise<{ key: unknown }> {
    return this.req('POST', `/keys/${encodeURIComponent(id)}/disable`, {});
  }
  rotateKey(id: string): Promise<MintedKey> {
    return this.req('POST', `/keys/${encodeURIComponent(id)}/rotate`, {});
  }

  // --- config collections ---
  listCollection(collection: CollectionName): Promise<{ entities: ScopedEntity[] }> {
    return this.req('GET', `/${collection}`);
  }
  createCollectionEntity(
    collection: CollectionName,
    input: { workspaceId: string; name: string; config?: Record<string, unknown> },
  ): Promise<{ entity: ScopedEntity }> {
    return this.req('POST', `/${collection}`, input);
  }
  updateCollectionEntity(
    collection: CollectionName,
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ): Promise<{ entity: ScopedEntity }> {
    return this.req('PUT', `/${collection}/${encodeURIComponent(id)}`, patch);
  }
  deleteCollectionEntity(collection: CollectionName, id: string): Promise<{ deleted: boolean }> {
    return this.req('DELETE', `/${collection}/${encodeURIComponent(id)}`);
  }

  // --- governed prompt registry ---
  listPrompts(): Promise<{ prompts: PromptSummaryView[] }> {
    return this.req('GET', '/prompts');
  }
  createPrompt(input: {
    workspaceId: string;
    name: string;
    body: string;
    message?: string;
  }): Promise<{ prompt: PromptTemplateView }> {
    return this.req('POST', '/prompts', input);
  }
  getPrompt(id: string): Promise<{ prompt: PromptTemplateView }> {
    return this.req('GET', `/prompts/${encodeURIComponent(id)}`);
  }
  addPromptVersion(
    id: string,
    input: { body: string; message?: string },
  ): Promise<{ version: PromptVersionView }> {
    return this.req('POST', `/prompts/${encodeURIComponent(id)}/versions`, input);
  }
  renderPrompt(
    id: string,
    input: { variables: Record<string, unknown>; version?: number },
  ): Promise<{ version: number; rendered: string }> {
    return this.req('POST', `/prompts/${encodeURIComponent(id)}/render`, input);
  }
  verifyPromptChain(id: string): Promise<ChainVerificationView> {
    return this.req('GET', `/prompts/${encodeURIComponent(id)}/verify`);
  }
  deletePrompt(id: string): Promise<{ deleted: boolean }> {
    return this.req('DELETE', `/prompts/${encodeURIComponent(id)}`);
  }

  // --- gitops + audit ---
  applyConfig(input: {
    document: Record<string, unknown>;
    baseVersion: number;
  }): Promise<{ version: number; contentHash: string }> {
    return this.req('POST', '/config/apply', input);
  }
  verifyAudit(): Promise<{ verified: boolean; count: number }> {
    return this.req('GET', '/audit/verify');
  }
}
