import type { IdentityProvider } from './idp';

/** Config for the real Entra (Azure AD) identity adapter. The Graph app registration
 *  needs the `User.Read.All` (or `Directory.Read.All`) APPLICATION permission with
 *  admin consent. `assertAllowed` lets the control plane apply its SSRF/air-gap egress
 *  guard without @gulley/oauth taking a dependency on @gulley/egress. */
export interface EntraGraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** default https://graph.microsoft.com */
  graphBase?: string;
  /** default https://login.microsoftonline.com */
  loginBase?: string;
  /** How long a last-known-good result may be reused if Graph is transiently
   *  unavailable (ms). Default 10 min. A hard error with no fresh cache fails closed. */
  cacheTtlMs?: number;
  /** Per-request deadline for the token + Graph calls (ms). Default 5 s. Without it
   *  a stalled Graph endpoint would hold every refresh for undici's ~300 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  assertAllowed?: (url: string) => void;
  now?: () => number;
}

interface TokenState {
  value: string;
  exp: number;
}

/**
 * Real Entra adapter for the OAuth broker's revoke-on-deprovision check. On each
 * refresh the broker calls `isPrincipalActive(oid)`; we ask Microsoft Graph whether
 * that directory object is still `accountEnabled`. A disabled/deleted user therefore
 * loses their broker (and, via short access TTLs, data-plane) access at the next
 * refresh rather than at the 90-day absolute TTL.
 *
 * Fail-closed on a definitive negative (disabled → false, 404/deleted → false) and,
 * on a transient Graph error, reuse a fresh last-known-good result or else deny.
 */
export class EntraGraphIdp implements IdentityProvider {
  readonly mode = 'entra' as const;
  private readonly graphBase: string;
  private readonly loginBase: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: TokenState;
  private readonly cache = new Map<string, { active: boolean; at: number }>();

  constructor(private readonly cfg: EntraGraphConfig) {
    this.graphBase = (cfg.graphBase ?? 'https://graph.microsoft.com').replace(/\/$/, '');
    this.loginBase = (cfg.loginBase ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
    this.cacheTtlMs = cfg.cacheTtlMs ?? 600_000;
    this.timeoutMs = cfg.timeoutMs ?? 5_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  async isPrincipalActive(subject: string): Promise<boolean> {
    const now = this.now();
    const cached = this.cache.get(subject);
    try {
      const token = await this.appToken();
      const url = `${this.graphBase}/v1.0/users/${encodeURIComponent(subject)}?$select=accountEnabled`;
      this.cfg.assertAllowed?.(url);
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        // Deleted from the directory — definitively inactive.
        this.cache.set(subject, { active: false, at: now });
        return false;
      }
      if (!res.ok) throw new Error(`graph users lookup ${res.status}`);
      const body = (await res.json()) as { accountEnabled?: boolean };
      const active = body.accountEnabled === true;
      this.cache.set(subject, { active, at: now });
      return active;
    } catch {
      // Transient failure: trust a fresh last-known-good result, else fail closed.
      if (cached && now - cached.at < this.cacheTtlMs) return cached.active;
      return false;
    }
  }

  private async appToken(): Promise<string> {
    const now = this.now();
    if (this.token && now < this.token.exp - 60_000) return this.token.value;
    const url = `${this.loginBase}/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`;
    this.cfg.assertAllowed?.(url);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: `${this.graphBase}/.default`,
    });
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`entra client-credentials token ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}
