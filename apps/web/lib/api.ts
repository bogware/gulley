import type {
  CollectionEntity,
  CollectionKind,
  LogFilter,
  LogPage,
  Org,
  Provider,
  RequestLog,
  UsageBucket,
  UsageQuery,
  VirtualKeyView,
  Workspace,
} from './types';

/**
 * Typed client for the Gulley control-api admin surface. Every call carries the
 * admin bearer token (an OIDC-minted admin session in production; a bootstrap
 * token in dev). The base URL comes from NEXT_PUBLIC_CONTROL_API_URL.
 */
export class GulleyAdminApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}${text ? `: ${text}` : ''}`);
    }
    return (await res.json()) as T;
  }

  private qs(params: object): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  // --- logs + analytics (the read APIs added in M7) ---
  logs(filter: LogFilter = {}): Promise<LogPage> {
    return this.req<LogPage>('GET', `/admin/logs${this.qs(filter)}`);
  }
  log(requestId: string): Promise<{ entry: RequestLog }> {
    return this.req<{ entry: RequestLog }>('GET', `/admin/logs/${encodeURIComponent(requestId)}`);
  }
  usage(query: UsageQuery = {}): Promise<{ buckets: UsageBucket[] }> {
    return this.req<{ buckets: UsageBucket[] }>('GET', `/admin/analytics/usage${this.qs(query)}`);
  }

  // --- orgs / workspaces ---
  orgs(): Promise<{ orgs: Org[] }> {
    return this.req<{ orgs: Org[] }>('GET', '/orgs');
  }
  createOrg(name: string): Promise<{ org: Org }> {
    return this.req<{ org: Org }>('POST', '/orgs', { name });
  }
  workspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.req<{ workspaces: Workspace[] }>('GET', '/workspaces');
  }
  createWorkspace(orgId: string, name: string): Promise<{ workspace: Workspace }> {
    return this.req<{ workspace: Workspace }>('POST', '/workspaces', { orgId, name });
  }

  // --- providers + credentials ---
  providers(): Promise<{ providers: Provider[] }> {
    return this.req<{ providers: Provider[] }>('GET', '/providers');
  }
  createProvider(
    workspaceId: string,
    kind: string,
    baseUrl?: string,
  ): Promise<{ provider: Provider }> {
    return this.req<{ provider: Provider }>('POST', '/providers', { workspaceId, kind, baseUrl });
  }
  setCredential(
    providerId: string,
    secretArn: string,
    secretVersion: string,
  ): Promise<{ credential: { id: string } }> {
    return this.req('POST', `/providers/${encodeURIComponent(providerId)}/credential`, {
      secretArn,
      secretVersion,
    });
  }

  // --- virtual keys ---
  createKey(
    workspaceId: string,
    name: string,
  ): Promise<{ id: string; token: string; keyPrefix: string }> {
    return this.req('POST', '/keys', { workspaceId, name });
  }
  key(id: string): Promise<{ key: VirtualKeyView }> {
    return this.req<{ key: VirtualKeyView }>('GET', `/keys/${encodeURIComponent(id)}`);
  }

  // --- workspace-scoped config collections (budgets / rate-limits / guardrails) ---
  collection(kind: CollectionKind): Promise<{ entities: CollectionEntity[] }> {
    return this.req<{ entities: CollectionEntity[] }>('GET', `/${kind}`);
  }
  createCollectionItem(
    kind: CollectionKind,
    workspaceId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<{ entity: CollectionEntity }> {
    return this.req<{ entity: CollectionEntity }>('POST', `/${kind}`, {
      workspaceId,
      name,
      config,
    });
  }

  verifyAudit(): Promise<{ verified: boolean; count: number }> {
    return this.req<{ verified: boolean; count: number }>('GET', '/audit/verify');
  }
}

/** The control-api base the browser calls. Defaults to the same-origin `/control`
 *  proxy (see next.config.mjs rewrites); override for a direct/CORS setup. */
export function controlApiUrl(): string {
  return process.env['NEXT_PUBLIC_CONTROL_API_URL'] ?? '/control';
}
