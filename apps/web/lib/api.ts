import type {
  AdminSessionInfo,
  AdminStatus,
  AdminUser,
  Attestation,
  AuditEvent,
  ChargebackQuery,
  ChargebackRow,
  CollectionEntity,
  CollectionKind,
  ConfigVersion,
  CryptoShredState,
  ClientConfigOptions,
  DeviceCodePreview,
  DeviceCodeView,
  GeneratedClientConfig,
  OAuthMetadata,
  DriftReport,
  EvalSuite,
  GatewayMetricsSummary,
  LogFilter,
  LogPage,
  MaskReveal,
  Membership,
  OAuthClient,
  OAuthGrant,
  Org,
  PromptTemplate,
  Provider,
  RequestLog,
  ReuseAlert,
  Rollout,
  ShadowSpendReport,
  UsageBucket,
  UsageQuery,
  VirtualKeyView,
  Workspace,
} from './types';

/**
 * A failed control-api call, classified. `status` 0 = the request never got an HTTP
 * answer (network down, proxy 502 is a real status; a client-side timeout is 0 with
 * `timeout: true`). `type`/`requestId` come from the API's error envelope when present.
 */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly type: string | undefined,
    readonly detail: string,
    readonly requestId?: string,
    readonly timeout = false,
  ) {
    super(
      status === 0
        ? `${method} ${path} → ${timeout ? 'timed out' : 'network error'}${detail ? `: ${detail}` : ''}`
        : `${method} ${path} → ${status}${detail ? `: ${detail}` : ''}${requestId ? ` (${requestId})` : ''}`,
    );
    this.name = 'ApiError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
  get forbidden(): boolean {
    return this.status === 403;
  }
  get notFound(): boolean {
    return this.status === 404;
  }
  get notConfigured(): boolean {
    return this.status === 501 || /not_configured|not_supported/i.test(this.type ?? '');
  }
}

const MAX_DETAIL = 300;

/** Parse an error body: the API envelope `{ error: { type, message, requestId } }`, an
 *  OAuth `{ error, error_description }`, or raw text — truncated so a stray HTML page
 *  or a stack never floods the UI. */
export function parseErrorBody(text: string): {
  type?: string;
  message: string;
  requestId?: string;
} {
  const raw = text.trim();
  if (!raw) return { message: '' };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const env = j['error'];
    if (env && typeof env === 'object') {
      const e = env as Record<string, unknown>;
      return {
        type: typeof e['type'] === 'string' ? e['type'] : undefined,
        message: typeof e['message'] === 'string' ? e['message'].slice(0, MAX_DETAIL) : '',
        requestId: typeof e['requestId'] === 'string' ? e['requestId'] : undefined,
      };
    }
    if (typeof env === 'string') {
      const d = j['error_description'];
      return { type: env, message: (typeof d === 'string' ? d : env).slice(0, MAX_DETAIL) };
    }
    if (typeof j['message'] === 'string') return { message: j['message'].slice(0, MAX_DETAIL) };
  } catch {
    /* not JSON */
  }
  return { message: raw.replace(/\s+/g, ' ').slice(0, MAX_DETAIL) };
}

/** Human-readable message for any thrown value (ApiError keeps its own). */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when an API error is a 501 "not configured" (a disabled optional subsystem),
 *  which pages render as a graceful "not enabled" state rather than a hard failure.
 *  Accepts the thrown error or the string a query hook surfaced. */
export function isNotConfigured(error: unknown): boolean {
  if (error instanceof ApiError) return error.notConfigured;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return !!text && (/→ 501/.test(text) || /not_configured|not_supported|not enabled/i.test(text));
}

export interface ApiOptions {
  /** Per-call deadline (ms). Default 15 s — a hung control API must not hang the console. */
  timeoutMs?: number;
  /** Fired on any 401: the session is gone (expired, revoked, logged out elsewhere). */
  onUnauthorized?: () => void;
}

/** Default per-call deadline. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Typed client for the Gulley control-api admin surface. Every call carries the
 * admin bearer token (an OIDC-minted admin session in production; a bootstrap
 * token in dev). The base URL comes from NEXT_PUBLIC_CONTROL_API_URL.
 */
export class GulleyAdminApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly opts: ApiOptions = {},
  ) {}

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Include the OIDC session cookie (http-only) so pasted-token auth is optional.
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = (e as { name?: string }).name === 'TimeoutError';
      throw new ApiError(
        method,
        path,
        0,
        undefined,
        timeout ? '' : describeError(e),
        undefined,
        timeout,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const parsed = parseErrorBody(text);
      const err = new ApiError(
        method,
        path,
        res.status,
        parsed.type,
        parsed.message,
        parsed.requestId,
      );
      if (err.unauthorized) this.opts.onUnauthorized?.();
      throw err;
    }
    return res;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(method, path, res.status, 'bad_response', 'response was not JSON');
    }
  }

  /** Unauthenticated liveness + build version of the control API (for the shell). */
  health(): Promise<{ status: string; service: string; version: string }> {
    return this.req('GET', '/health');
  }

  // --- auth (OIDC session gate) ---
  authConfig(): Promise<{ enabled: boolean; loginUrl: string }> {
    return this.req<{ enabled: boolean; loginUrl: string }>('GET', '/auth/config');
  }
  me(): Promise<{ subject: string; name: string; memberships: unknown[] }> {
    return this.req<{ subject: string; name: string; memberships: unknown[] }>('GET', '/auth/me');
  }
  async logout(): Promise<void> {
    await fetch(`${this.baseUrl}/auth/logout`, { method: 'POST', credentials: 'include' });
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

  private async reqText(path: string): Promise<string> {
    return (await this.raw('GET', path)).text();
  }

  // --- lifecycle / CRUD (deletes + updates the console previously lacked) ---
  deleteOrg(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/orgs/${encodeURIComponent(id)}`);
  }
  deleteWorkspace(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/workspaces/${encodeURIComponent(id)}`);
  }
  deleteProvider(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/providers/${encodeURIComponent(id)}`);
  }
  updateProvider(id: string, patch: { enabled?: boolean; baseUrl?: string }) {
    return this.req<{ provider: Provider }>('PUT', `/providers/${encodeURIComponent(id)}`, patch);
  }
  providerCredential(id: string) {
    return this.req<{ configured: boolean; ref?: string }>(
      'GET',
      `/providers/${encodeURIComponent(id)}/credential`,
    );
  }
  updateCollectionItem(
    kind: CollectionKind,
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ) {
    return this.req<{ entity: CollectionEntity }>(
      'PUT',
      `/${kind}/${encodeURIComponent(id)}`,
      patch,
    );
  }
  deleteCollectionItem(kind: CollectionKind, id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/${kind}/${encodeURIComponent(id)}`);
  }

  // --- virtual keys (list + lifecycle) ---
  listKeys(workspaceId: string) {
    return this.req<{ keys: VirtualKeyView[] }>('GET', `/keys${this.qs({ workspaceId })}`);
  }
  disableKey(id: string) {
    return this.req<{ key: VirtualKeyView }>('POST', `/keys/${encodeURIComponent(id)}/disable`);
  }
  rotateKey(id: string) {
    return this.req<{ id: string; token: string; keyPrefix: string }>(
      'POST',
      `/keys/${encodeURIComponent(id)}/rotate`,
    );
  }

  // --- config (GitOps editor) ---
  configExport() {
    return this.req<{ document: unknown }>('GET', '/config/export');
  }
  configPlan(document: unknown) {
    return this.req<{ plan: unknown }>('POST', '/config/plan', { document });
  }
  configApply(document: unknown, baseVersion: number) {
    return this.req<{ version: number; contentHash: string; plan: unknown }>(
      'POST',
      '/config/apply',
      {
        document,
        baseVersion,
      },
    );
  }
  configDrift() {
    return this.req<DriftReport>('GET', '/config/drift');
  }
  configVersions() {
    return this.req<{ version: number; current: ConfigVersion | null }>('GET', '/config/versions');
  }
  configVersionHistory(limit = 50) {
    return this.req<{ versions: ConfigVersion[] }>(
      'GET',
      `/config/versions/history${this.qs({ limit })}`,
    );
  }

  // --- prompts registry ---
  prompts() {
    return this.req<{ prompts: PromptTemplate[] }>('GET', '/prompts');
  }
  prompt(id: string) {
    return this.req<{ prompt: PromptTemplate }>('GET', `/prompts/${encodeURIComponent(id)}`);
  }
  createPrompt(workspaceId: string, name: string, body: string) {
    return this.req<{ prompt: PromptTemplate }>('POST', '/prompts', { workspaceId, name, body });
  }
  addPromptVersion(id: string, body: string) {
    return this.req<{ version: unknown }>('POST', `/prompts/${encodeURIComponent(id)}/versions`, {
      body,
    });
  }
  verifyPrompt(id: string) {
    return this.req<{ verified: boolean }>('GET', `/prompts/${encodeURIComponent(id)}/verify`);
  }
  renderPrompt(id: string, variables: Record<string, string>) {
    return this.req<{ rendered: string }>('POST', `/prompts/${encodeURIComponent(id)}/render`, {
      variables,
    });
  }
  deletePrompt(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/prompts/${encodeURIComponent(id)}`);
  }

  // --- compliance ---
  auditEvents(query: { limit?: number; before?: number } = {}) {
    return this.req<{ events: AuditEvent[]; nextCursor?: number }>(
      'GET',
      `/audit/events${this.qs(query)}`,
    );
  }
  auditAttestation() {
    return this.req<Attestation>('GET', '/audit/attestation');
  }
  evidenceBundle() {
    return this.req<unknown>('GET', '/audit/evidence-bundle');
  }
  wormStatus() {
    return this.req<Record<string, unknown>>('GET', '/audit/worm/status');
  }
  wormShip() {
    return this.req<Record<string, unknown>>('POST', '/audit/worm/ship');
  }
  wormVerify() {
    return this.req<Record<string, unknown>>('GET', '/audit/worm/verify');
  }
  anchorNow() {
    return this.req<Record<string, unknown>>('POST', '/audit/anchor');
  }
  anchors() {
    return this.req<{ anchors: unknown[] }>('GET', '/audit/anchors');
  }
  anchorVerify() {
    return this.req<Record<string, unknown>>('GET', '/audit/anchor/verify');
  }
  siemStatus() {
    return this.req<Record<string, unknown>>('GET', '/audit/siem/status');
  }
  siemExport() {
    return this.req<Record<string, unknown>>('POST', '/audit/siem/export');
  }

  // --- privacy (crypto-shred + mask reveal) ---
  cryptoShredState(subject: string) {
    return this.req<CryptoShredState>('GET', `/admin/crypto-shred/${encodeURIComponent(subject)}`);
  }
  cryptoShred(subject: string) {
    return this.req<{ subject: string; shredded: boolean }>(
      'POST',
      `/admin/crypto-shred/${encodeURIComponent(subject)}`,
    );
  }
  maskVaultReveal(requestId: string) {
    return this.req<MaskReveal>('GET', `/admin/mask-vault/${encodeURIComponent(requestId)}`);
  }

  // --- finops ---
  chargeback(query: ChargebackQuery = {}) {
    return this.req<{ rows: ChargebackRow[] }>(
      'GET',
      `/admin/analytics/chargeback${this.qs(query)}`,
    );
  }
  shadowSpend(query: { workspaceId?: string; from?: string; to?: string } = {}) {
    return this.req<ShadowSpendReport>('GET', `/admin/analytics/shadow-spend${this.qs(query)}`);
  }

  // --- eval rollouts ---
  evalSuites() {
    return this.req<{ suites: EvalSuite[] }>('GET', '/admin/eval-suites');
  }
  saveEvalSuite(suite: unknown) {
    return this.req<{ suite: EvalSuite }>('POST', '/admin/eval-suites', suite);
  }
  deleteEvalSuite(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/admin/eval-suites/${encodeURIComponent(id)}`);
  }
  rollouts() {
    return this.req<{ rollouts: Rollout[] }>('GET', '/admin/rollouts');
  }
  createRollout(rollout: unknown) {
    return this.req<{ rollout: Rollout }>('POST', '/admin/rollouts', rollout);
  }
  runRollout(id: string) {
    return this.req<{ rollout: Rollout }>('POST', `/admin/rollouts/${encodeURIComponent(id)}/run`);
  }

  // --- observability ---
  observabilityMetrics() {
    return this.req<{ metrics: GatewayMetricsSummary }>('GET', '/admin/observability/metrics');
  }
  observabilityStatus() {
    return this.req<{
      configured: boolean;
      reachable?: boolean;
      latencyMs?: number;
      error?: string;
    }>('GET', '/admin/observability/status');
  }

  // --- settings / status ---
  adminStatus() {
    return this.req<AdminStatus>('GET', '/admin/status');
  }
  logLevel() {
    return this.req<{ level: string }>('GET', '/admin/log-level');
  }
  setLogLevel(level: string) {
    return this.req<{ level: string }>('POST', '/admin/log-level', { level });
  }
  configDump() {
    return this.req<Record<string, unknown>>('GET', '/admin/config-dump');
  }

  // --- identity ---
  adminUsers() {
    return this.req<{ durable: boolean; users: AdminUser[] }>('GET', '/admin/users');
  }
  userMemberships(id: string) {
    return this.req<{ user: unknown; memberships: Membership[] }>(
      'GET',
      `/admin/users/${encodeURIComponent(id)}/memberships`,
    );
  }
  memberships() {
    return this.req<{ memberships: Membership[] }>('GET', '/memberships');
  }
  createMembership(m: { subject: string; role: string; orgId: string; workspaceId?: string }) {
    return this.req<{ membership: Membership }>('POST', '/memberships', m);
  }
  deleteMembership(id: string) {
    return this.req<{ deleted: boolean }>('DELETE', `/memberships/${encodeURIComponent(id)}`);
  }
  sessions() {
    return this.req<{ enumerable: boolean; sessions: AdminSessionInfo[] }>(
      'GET',
      '/admin/sessions',
    );
  }
  revokeSession(jti: string) {
    return this.req<{ revoked: boolean }>('DELETE', `/admin/sessions/${encodeURIComponent(jti)}`);
  }
  oauthClients() {
    return this.req<{ clients: OAuthClient[] }>('GET', '/admin/oauth/clients');
  }
  saveOAuthClient(client: unknown) {
    return this.req<{ client: OAuthClient }>('POST', '/admin/oauth/clients', client);
  }
  deleteOAuthClient(clientId: string) {
    return this.req<{ deleted: boolean }>(
      'DELETE',
      `/admin/oauth/clients/${encodeURIComponent(clientId)}`,
    );
  }
  oauthGrants() {
    return this.req<{ grants: OAuthGrant[] }>('GET', '/admin/oauth/grants');
  }
  revokeOAuthGrant(handle: string) {
    return this.req<{ revoked: boolean }>(
      'POST',
      `/admin/oauth/grants/${encodeURIComponent(handle)}/revoke`,
    );
  }
  oauthDeviceCodes() {
    return this.req<{ deviceCodes: DeviceCodeView[] }>('GET', '/admin/oauth/device-codes');
  }
  // --- device-flow consent (the broker's /oauth/device page, console edition) ---
  deviceCodePreview(userCode: string) {
    return this.req<DeviceCodePreview>(
      'GET',
      `/oauth/device/preview?user_code=${encodeURIComponent(userCode)}`,
    );
  }
  approveDeviceCode(userCode: string) {
    return this.req<{ approved: boolean }>('POST', '/oauth/device/authorize', {
      user_code: userCode,
    });
  }
  denyDeviceCode(userCode: string) {
    return this.req<{ denied: boolean }>('POST', '/oauth/device/deny', { user_code: userCode });
  }
  oauthMetadata() {
    return this.req<OAuthMetadata>('GET', '/.well-known/oauth-authorization-server');
  }
  refreshReuse() {
    return this.req<{ alerts: ReuseAlert[] }>('GET', '/admin/security/refresh-reuse');
  }
  clientConfig(workspaceId: string, opts: ClientConfigOptions = {}) {
    return this.req<{ config: GeneratedClientConfig }>(
      'GET',
      `/admin/workspaces/${encodeURIComponent(workspaceId)}/client-config${this.qs(opts)}`,
    );
  }
  onboardingPack(workspaceId: string, opts: ClientConfigOptions = {}) {
    return this.req<Record<string, unknown>>(
      'GET',
      `/admin/workspaces/${encodeURIComponent(workspaceId)}/onboarding-pack${this.qs(opts)}`,
    );
  }
}

/** The control-api base the browser calls. Defaults to the same-origin `/control`
 *  proxy (see next.config.mjs rewrites); override for a direct/CORS setup. */
export function controlApiUrl(): string {
  return process.env['NEXT_PUBLIC_CONTROL_API_URL'] ?? '/control';
}
