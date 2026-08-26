import type {
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

  // --- config CRUD (existing control-api endpoints) ---
  orgs(): Promise<{ orgs: Org[] }> {
    return this.req<{ orgs: Org[] }>('GET', '/orgs');
  }
  workspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.req<{ workspaces: Workspace[] }>('GET', '/workspaces');
  }
  providers(): Promise<{ providers: Provider[] }> {
    return this.req<{ providers: Provider[] }>('GET', '/providers');
  }
  createKey(
    workspaceId: string,
    name: string,
  ): Promise<{ id: string; token: string; keyPrefix: string }> {
    return this.req('POST', '/keys', { workspaceId, name });
  }
  key(id: string): Promise<{ key: VirtualKeyView }> {
    return this.req<{ key: VirtualKeyView }>('GET', `/keys/${encodeURIComponent(id)}`);
  }
  verifyAudit(): Promise<{ verified: boolean; count: number }> {
    return this.req<{ verified: boolean; count: number }>('GET', '/audit/verify');
  }
}

/** Read the control-api base URL from the environment (client-safe). */
export function controlApiUrl(): string {
  return process.env['NEXT_PUBLIC_CONTROL_API_URL'] ?? 'http://localhost:8081';
}
