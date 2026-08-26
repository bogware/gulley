import {
  type ClaimFailure,
  decodeJwtHeader,
  type Jwk,
  type JwtClaims,
  validateClaims,
  type VerifyFailure,
  verifyJwtWithJwks,
} from './jwt';

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const d = (await res.json()) as Partial<OidcMetadata>;
  if (!d.issuer || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
    throw new Error('OIDC discovery document is missing required endpoints');
  }
  return {
    issuer: d.issuer,
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
  };
}

export async function fetchJwks(jwksUri: string, fetchImpl: typeof fetch = fetch): Promise<Jwk[]> {
  const res = await fetchImpl(jwksUri);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const d = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(d.keys) ? d.keys : [];
}

export interface OidcProviderOptions {
  fetchImpl?: typeof fetch;
  /** Cache TTL for discovery + JWKS (ms). Default 1h. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * An OIDC provider: caches the discovery document and JWKS, and verifies tokens
 * against them — refreshing the JWKS at most once a minute when a token's `kid`
 * is unknown (signing-key rotation). Reused by the control-plane session gate and
 * the data-plane inbound-JWT auth mode.
 */
export class OidcProvider {
  private metadata?: { value: OidcMetadata; at: number };
  private jwks?: { keys: Jwk[]; at: number };
  private lastRefresh = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(
    readonly issuer: string,
    opts: OidcProviderOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.nowFn = opts.now ?? Date.now;
  }

  async metadataDoc(): Promise<OidcMetadata> {
    if (this.metadata && this.nowFn() - this.metadata.at < this.ttlMs) return this.metadata.value;
    const value = await fetchDiscovery(this.issuer, this.fetchImpl);
    this.metadata = { value, at: this.nowFn() };
    return value;
  }

  private async keys(force = false): Promise<Jwk[]> {
    if (!force && this.jwks && this.nowFn() - this.jwks.at < this.ttlMs) return this.jwks.keys;
    const md = await this.metadataDoc();
    const keys = await fetchJwks(md.jwks_uri, this.fetchImpl);
    this.jwks = { keys, at: this.nowFn() };
    return keys;
  }

  /** Verify a token's signature (JWKS) and standard claims. `issuer` defaults to
   *  this provider's discovered issuer. */
  async verify(
    jwt: string,
    expectations: { audience: string | string[]; nonce?: string; issuer?: string },
  ): Promise<
    { ok: true; claims: JwtClaims } | { ok: false; reason: VerifyFailure | ClaimFailure }
  > {
    const header = decodeJwtHeader(jwt);
    let keys = await this.keys();
    if (
      header?.kid &&
      !keys.some((k) => k.kid === header.kid) &&
      this.nowFn() - this.lastRefresh > 60_000
    ) {
      this.lastRefresh = this.nowFn();
      keys = await this.keys(true);
    }
    const v = verifyJwtWithJwks(jwt, keys);
    if (!v.ok) return { ok: false, reason: v.reason };
    const issuer = expectations.issuer ?? (await this.metadataDoc()).issuer;
    const c = validateClaims(v.claims, {
      issuer,
      audience: expectations.audience,
      nonce: expectations.nonce,
      now: this.nowFn(),
    });
    if (!c.ok) return { ok: false, reason: c.reason };
    return { ok: true, claims: v.claims };
  }
}
