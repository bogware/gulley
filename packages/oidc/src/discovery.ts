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

/** Default per-request timeout for discovery/JWKS fetches. `global fetch` (undici)
 *  imposes NO total-request timeout, so an unreachable IdP would otherwise stall an
 *  inbound-JWT auth request on the data-plane hot path for undici's ~300s header
 *  timeout — piling up event-loop-bound promises exactly during a boot spike or a
 *  signing-key rotation. Bound every metadata/JWKS fetch. */
export const DEFAULT_OIDC_FETCH_TIMEOUT_MS = 5_000;

/** Outbound guard applied to every URL the provider fetches (discovery, JWKS) and
 *  to the endpoints the document advertises. `assertAllowed` throws to deny (the
 *  control plane wires its SSRF/air-gap egress guard here); `requireHttps` rejects a
 *  plaintext issuer or advertised endpoint (an attacker who can inject an `http://`
 *  token_endpoint into discovery would otherwise receive the client secret). */
export interface OidcFetchGuard {
  assertAllowed?: (url: string) => void;
  requireHttps?: boolean;
}

/** fetch with a total-request deadline; a timeout surfaces as a normal fetch error.
 *  Redirects are refused: a redirecting IdP endpoint is a rebind vector. */
function timedFetch(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  guard?: OidcFetchGuard,
): Promise<Response> {
  guard?.assertAllowed?.(url);
  return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
}

const normalizeIssuer = (s: string): string => s.replace(/\/+$/, '');

function assertEndpoint(name: string, url: string, guard: OidcFetchGuard | undefined): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`OIDC discovery: ${name} is not a valid URL`);
  }
  if (guard?.requireHttps && u.protocol !== 'https:') {
    throw new Error(`OIDC discovery: ${name} must be https`);
  }
  guard?.assertAllowed?.(url);
}

export async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_OIDC_FETCH_TIMEOUT_MS,
  guard?: OidcFetchGuard,
): Promise<OidcMetadata> {
  if (guard?.requireHttps && !/^https:\/\//i.test(issuer)) {
    throw new Error('OIDC issuer must be https');
  }
  const url = `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
  const res = await timedFetch(url, fetchImpl, timeoutMs, guard);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const d = (await res.json()) as Partial<OidcMetadata>;
  if (!d.issuer || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
    throw new Error('OIDC discovery document is missing required endpoints');
  }
  // RFC 8414 §3.3: the document's issuer MUST match the one it was fetched for —
  // otherwise a compromised/misrouted discovery host could redirect the whole flow.
  if (normalizeIssuer(d.issuer) !== normalizeIssuer(issuer)) {
    throw new Error('OIDC discovery issuer does not match the configured issuer');
  }
  assertEndpoint('authorization_endpoint', d.authorization_endpoint, guard);
  assertEndpoint('token_endpoint', d.token_endpoint, guard);
  assertEndpoint('jwks_uri', d.jwks_uri, guard);
  return {
    issuer: d.issuer,
    authorization_endpoint: d.authorization_endpoint,
    token_endpoint: d.token_endpoint,
    jwks_uri: d.jwks_uri,
  };
}

export async function fetchJwks(
  jwksUri: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_OIDC_FETCH_TIMEOUT_MS,
  guard?: OidcFetchGuard,
): Promise<Jwk[]> {
  const res = await timedFetch(jwksUri, fetchImpl, timeoutMs, guard);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const d = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(d.keys) ? d.keys : [];
}

export interface OidcProviderOptions {
  fetchImpl?: typeof fetch;
  /** Cache TTL for discovery + JWKS (ms). Default 1h. */
  ttlMs?: number;
  now?: () => number;
  /** Per-request timeout for discovery/JWKS fetches (ms). Default 5s. */
  fetchTimeoutMs?: number;
  /** Egress guard + https policy for every URL fetched or advertised. */
  guard?: OidcFetchGuard;
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
  private readonly fetchTimeoutMs: number;
  private readonly guard: OidcFetchGuard | undefined;
  // Single-flight the network fetches: on a cold cache (boot) or a rotation refresh,
  // N concurrent JWT verifications would otherwise each fire an independent fetch.
  private metadataInflight?: Promise<OidcMetadata>;
  private keysInflight?: Promise<Jwk[]>;

  constructor(
    readonly issuer: string,
    opts: OidcProviderOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.nowFn = opts.now ?? Date.now;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_OIDC_FETCH_TIMEOUT_MS;
    this.guard = opts.guard;
  }

  async metadataDoc(): Promise<OidcMetadata> {
    if (this.metadata && this.nowFn() - this.metadata.at < this.ttlMs) return this.metadata.value;
    if (this.metadataInflight) return this.metadataInflight;
    this.metadataInflight = fetchDiscovery(
      this.issuer,
      this.fetchImpl,
      this.fetchTimeoutMs,
      this.guard,
    )
      .then((value) => {
        this.metadata = { value, at: this.nowFn() };
        return value;
      })
      .finally(() => {
        this.metadataInflight = undefined;
      });
    return this.metadataInflight;
  }

  private async keys(force = false): Promise<Jwk[]> {
    if (!force && this.jwks && this.nowFn() - this.jwks.at < this.ttlMs) return this.jwks.keys;
    if (this.keysInflight) return this.keysInflight;
    this.keysInflight = (async () => {
      const md = await this.metadataDoc();
      const keys = await fetchJwks(md.jwks_uri, this.fetchImpl, this.fetchTimeoutMs, this.guard);
      this.jwks = { keys, at: this.nowFn() };
      return keys;
    })().finally(() => {
      this.keysInflight = undefined;
    });
    return this.keysInflight;
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
      // Serve-stale on a refresh failure: a timed-out/unreachable JWKS endpoint during
      // key rotation must NOT throw out of verify() (that would 500 the request). Fall
      // back to the currently-cached keys — an unknown kid then yields a clean signature
      // deny (fail-closed), while a still-valid kid keeps verifying through the hiccup.
      keys = await this.keys(true).catch(() => keys);
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
