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
}

export class ControlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`control API ${status}`);
    this.name = 'ControlApiError';
  }
}

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

  constructor(opts: ControlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    const injected = opts.fetch ?? globalThis.fetch;
    if (!injected) throw new Error('no fetch available; pass options.fetch');
    this.f = injected;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const hasBody = body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) throw new ControlApiError(res.status, json);
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
