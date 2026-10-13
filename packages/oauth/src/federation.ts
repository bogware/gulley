import { err, ok, type Result } from '@gulley/core';
import {
  decodeJwtHeader,
  decodeJwtPayload,
  type JwtClaims,
  OidcProvider,
  type OidcProviderOptions,
} from '@gulley/oidc';
import { createHash } from 'node:crypto';
import type { GrantScope } from './stores';

/**
 * Workload identity federation (RFC 7523 JWT-bearer): a TRUST CONFIGURATION that
 * says which external issuer's tokens, for which subjects, map to which Gulley
 * tenancy + scope. A Kubernetes service-account token or a GitHub Actions OIDC
 * token presented to `POST /oauth/token` with
 * `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` is verified against the
 * matching federation and exchanged for a short-lived, scoped, ACCESS-ONLY `gko_at_`
 * token bound to the service principal `svc:<federation>:<sub>`.
 */
export interface WorkloadFederation {
  /** Short handle; becomes part of the principal id (`[A-Za-z0-9._-]`, unique). */
  name: string;
  /** The assertion's `iss`, verbatim (trailing slash tolerated). */
  issuer: string;
  /** Where the issuer's signing keys live. Default: read `jwks_uri` from
   *  `<issuer>/.well-known/openid-configuration` (lenient: issuer + jwks_uri only). */
  jwksUri?: string;
  /** Accepted `aud` value(s). Default: the broker's public origin (the control-plane
   *  URL the workload was told to request a token for). */
  audience?: string | readonly string[];
  /** Permit an in-cluster / RFC 1918 JWKS host (a Kubernetes API server). The SSRF
   *  egress guard and the DNS-pinned fetch are bypassed for THIS federation only. */
  allowInternal?: boolean;
  /** Which subjects of this issuer are admitted. `pattern` is a `:`-segmented glob
   *  (`*` = one segment, `**` = the rest); `claims` are exact matches on the listed
   *  claims (a listed array = any of). Both apply when both are set. */
  subject: {
    pattern?: string;
    claims?: Readonly<Record<string, string | readonly string[]>>;
  };
  orgId: string;
  workspaceId: string;
  /** Data-plane scope of the minted token. Default `'*'` providers + models. */
  scope?: {
    allowedProviders?: readonly string[] | '*';
    allowedModels?: readonly string[] | '*';
    groups?: readonly string[];
  };
  /** Access-token lifetime. Default 3600, max 86400. */
  ttlSeconds?: number;
  /** May this principal assert an end user per request (`x-user-id`)? Default false. */
  onBehalfOf?: boolean;
  /** Display name of the service principal; default `<name>: <sub>`. */
  displayName?: string;
}

export const DEFAULT_FEDERATION_TTL_SECONDS = 3600;
export const MAX_FEDERATION_TTL_SECONDS = 86_400;
/** An assertion's `iat` may be at most this old (seconds). Workload tokens are
 *  minted for the exchange; a stale one is a replay or a leaked long-lived token. */
export const MAX_ASSERTION_AGE_SECONDS = 600;
/** Clock-skew tolerance (seconds) for `exp` / `nbf` / `iat`. */
export const ASSERTION_SKEW_SECONDS = 60;
/** Upper bound on remembered `jti`s per process (see {@link JtiReplayCache}). */
export const DEFAULT_MAX_JTI_ENTRIES = 100_000;
/** Longest `sub` carried verbatim in a principal id; longer ones are shortened. */
export const MAX_SUBJECT_LENGTH = 200;

/** The verified identity a federation admits, as the broker consumes it. */
export interface FederatedIdentity {
  federation: string;
  /** The assertion's `sub`, verbatim. */
  subject: string;
  /** `svc:<federation>:<sub>` (sub shortened + hashed when > 200 chars). */
  principalId: string;
  displayName: string;
  orgId: string;
  workspaceId: string;
  scope: GrantScope;
  ttlSeconds: number;
  onBehalfOf: boolean;
  /** The verified claims (for audit payloads — never echoed to the caller). */
  claims: JwtClaims;
}

export type FederationFailure =
  | 'malformed'
  | 'unknown-issuer'
  | 'unsupported-alg'
  | 'no-matching-key'
  | 'bad-key'
  | 'bad-signature'
  | 'iss'
  | 'aud'
  | 'expired'
  | 'not-yet-valid'
  | 'nonce'
  | 'iat-missing'
  | 'iat-future'
  | 'iat-stale'
  | 'replayed'
  | 'subject-mismatch'
  | 'jwks-unavailable';

/** The port the broker depends on (a fake in unit tests, the real verifier in prod). */
export interface FederationVerifierPort {
  verify(
    assertion: string,
    opts?: { defaultAudience?: string },
  ): Promise<Result<FederatedIdentity, { reason: FederationFailure }>>;
}

/** What verifies a signature + the standard claims for one issuer — an
 *  {@link OidcProvider} in jwks-only mode, or a stub in tests. */
export interface IssuerKeyring {
  verify(
    jwt: string,
    expectations: { audience: string | string[]; issuer?: string },
  ): Promise<{ ok: true; claims: JwtClaims } | { ok: false; reason: string }>;
}

export interface FederationVerifierOptions {
  federations: readonly WorkloadFederation[];
  /** HTTP for discovery/JWKS fetches, per federation (prod: the DNS-pinned fetch,
   *  or plain fetch for `allowInternal`). Default: global fetch. */
  fetchFor?: (federation: WorkloadFederation) => typeof fetch;
  /** Egress guard for every discovery/JWKS URL of a federation (the control plane
   *  wires its SSRF/air-gap guard; `allowInternal` federations are passed through). */
  assertEgress?: (url: string, federation: WorkloadFederation) => void;
  /** Require https issuers/JWKS endpoints (production). */
  requireHttps?: boolean;
  fetchTimeoutMs?: number;
  /** JWKS cache TTL (ms). Default 1 h; an unknown `kid` refreshes at most once a minute. */
  jwksTtlMs?: number;
  now?: () => number;
  maxJtiEntries?: number;
  /** Test seam: build the per-issuer keyring instead of an OidcProvider. */
  keyringFor?: (federation: WorkloadFederation) => IssuerKeyring;
}

/** Trailing slashes off an issuer, without a backtracking regex (`/\/+$/` is
 *  quadratic on a long run of slashes). */
const normalizeIssuer = (s: string): string => {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
};

/**
 * Compile a `:`-segmented subject glob. `*` matches exactly one segment (any run of
 * characters without `:`); `**` matches the remainder (including `:`). Everything
 * else is literal, so `repo:acme/api:ref:refs/heads/main` matches only itself and
 * `system:serviceaccount:prod:*` admits every service account of ONE namespace.
 */
export function compileSubjectPattern(pattern: string): RegExp {
  const parts = pattern.split('**');
  const seg = (s: string): string =>
    s
      .split('*')
      .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^:]*');
  return new RegExp(`^${parts.map(seg).join('.*')}$`);
}

/**
 * Read a claim for matching: the exact key first, else a `/`-separated path into
 * nested claims — so `kubernetes.io/namespace` reads the projected service-account
 * token's `{"kubernetes.io": {"namespace": …}}` and
 * `kubernetes.io/serviceaccount/name` its account name. Scalars only.
 */
export function claimValue(claims: JwtClaims, key: string): string | undefined {
  const scalar = (v: unknown): string | undefined =>
    typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : undefined;
  if (key in claims) return scalar(claims[key]);
  if (!key.includes('/')) return undefined;
  let cur: unknown = claims;
  for (const seg of key.split('/')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return scalar(cur);
}

export function subjectMatches(fed: WorkloadFederation, claims: JwtClaims): boolean {
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) return false;
  const { pattern, claims: wanted } = fed.subject;
  if (!pattern && !wanted) return false; // a federation must constrain something
  if (pattern && !compileSubjectPattern(pattern).test(sub)) return false;
  if (wanted) {
    for (const [claim, allowed] of Object.entries(wanted)) {
      const value = claimValue(claims, claim);
      if (value === undefined) return false;
      const list = typeof allowed === 'string' ? [allowed] : allowed;
      if (!list.includes(value)) return false;
    }
  }
  return true;
}

/** The service principal id for a federation + subject; a very long `sub` (some
 *  IdPs emit URIs/JSON) is shortened and suffixed with a hash so ids stay bounded
 *  and distinct. */
export function servicePrincipalId(federation: string, sub: string): string {
  const safe =
    sub.length > MAX_SUBJECT_LENGTH
      ? `${sub.slice(0, MAX_SUBJECT_LENGTH - 17)}#${createHash('sha256').update(sub).digest('hex').slice(0, 16)}`
      : sub;
  return `svc:${federation}:${safe}`;
}

/**
 * In-memory `jti` replay guard. PER-PROCESS: a replica fleet behind one broker URL
 * shares no state, so a replayed assertion is rejected only by the replica that saw
 * it first (the 10-minute `iat` window bounds the exposure; a Redis-backed set is the
 * cross-replica upgrade). Bounded to `max` entries — when full, expired entries are
 * swept first and then the OLDEST live entry is evicted (insertion order), so a flood
 * of fresh assertions can at worst shorten another assertion's replay protection,
 * never grow the heap unboundedly.
 */
export class JtiReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = DEFAULT_MAX_JTI_ENTRIES) {}

  get size(): number {
    return this.seen.size;
  }

  /** True when `key` was already recorded and has not expired. */
  has(key: string, nowMs: number): boolean {
    const exp = this.seen.get(key);
    if (exp === undefined) return false;
    if (exp <= nowMs) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  /** Record `key` until `expiresAtMs`. */
  add(key: string, expiresAtMs: number, nowMs: number): void {
    if (this.seen.size >= this.max) {
      for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
      while (this.seen.size >= this.max) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
    }
    this.seen.set(key, expiresAtMs);
  }
}

/**
 * Verifies a workload assertion against the configured federations:
 *
 *   1. route by the (unverified) `iss` to the federations for that issuer;
 *   2. signature (the RS, PS and ES families only — the keyring rejects `none` and
 *      the HMAC algorithms), `iss`, `aud`, `exp` (60 s skew), `nbf`;
 *   3. `iat` present, not in the future, not older than 10 minutes;
 *   4. `jti` replay (per process, see {@link JtiReplayCache}; a token without `jti`
 *      is keyed by its signature);
 *   5. the subject pattern / claims of the first federation that admits it.
 *
 * Signing keys are cached per issuer (TTL, single-flight, unknown-kid refresh with
 * serve-stale) through {@link OidcProvider} in jwks-only mode. Every failure maps to
 * a generic `invalid_grant` at the HTTP surface; the detailed reason is for logs.
 */
export class FederationVerifier implements FederationVerifierPort {
  private readonly byIssuer = new Map<string, WorkloadFederation[]>();
  private readonly keyrings = new Map<string, IssuerKeyring>();
  private readonly replay: JtiReplayCache;
  private readonly now: () => number;

  constructor(private readonly opts: FederationVerifierOptions) {
    for (const f of opts.federations) {
      const key = normalizeIssuer(f.issuer);
      const list = this.byIssuer.get(key) ?? [];
      list.push(f);
      this.byIssuer.set(key, list);
    }
    this.replay = new JtiReplayCache(opts.maxJtiEntries ?? DEFAULT_MAX_JTI_ENTRIES);
    this.now = opts.now ?? Date.now;
  }

  get federations(): readonly WorkloadFederation[] {
    return this.opts.federations;
  }

  private keyring(fed: WorkloadFederation): IssuerKeyring {
    // One keyring per (issuer, jwksUri, allowInternal) so federations sharing an
    // issuer share its JWKS cache.
    const key = `${normalizeIssuer(fed.issuer)}|${fed.jwksUri ?? ''}|${fed.allowInternal ? 'i' : 'e'}`;
    let k = this.keyrings.get(key);
    if (k) return k;
    if (this.opts.keyringFor) {
      k = this.opts.keyringFor(fed);
    } else {
      const providerOpts: OidcProviderOptions = {
        fetchImpl: this.opts.fetchFor?.(fed) ?? fetch,
        fetchTimeoutMs: this.opts.fetchTimeoutMs,
        ttlMs: this.opts.jwksTtlMs,
        now: this.now,
        guard: {
          assertAllowed: (url) => this.opts.assertEgress?.(url, fed),
          requireHttps: this.opts.requireHttps,
        },
        ...(fed.jwksUri ? { jwksUri: fed.jwksUri } : { discovery: 'lenient' as const }),
      };
      k = new OidcProvider(normalizeIssuer(fed.issuer), providerOpts);
    }
    this.keyrings.set(key, k);
    return k;
  }

  async verify(
    assertion: string,
    opts: { defaultAudience?: string } = {},
  ): Promise<Result<FederatedIdentity, { reason: FederationFailure }>> {
    const fail = (reason: FederationFailure): Result<never, { reason: FederationFailure }> =>
      err({ reason });
    if (typeof assertion !== 'string' || assertion.length === 0 || assertion.length > 16_384) {
      return fail('malformed');
    }
    const header = decodeJwtHeader(assertion);
    const unverified = decodeJwtPayload(assertion);
    if (!header || !unverified || typeof unverified.iss !== 'string') return fail('malformed');
    const candidates = this.byIssuer.get(normalizeIssuer(unverified.iss));
    if (!candidates || candidates.length === 0) return fail('unknown-issuer');

    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    let verified: { fed: WorkloadFederation; claims: JwtClaims } | undefined;
    let lastReason: FederationFailure = 'subject-mismatch';
    // Federations for one issuer may differ in audience; verify under each until one
    // admits the token's signature + standard claims, then match its subject rule.
    for (const fed of candidates) {
      const audience = fed.audience
        ? typeof fed.audience === 'string'
          ? fed.audience
          : [...fed.audience]
        : opts.defaultAudience;
      if (!audience) {
        lastReason = 'aud';
        continue;
      }
      let r: Awaited<ReturnType<IssuerKeyring['verify']>>;
      try {
        // The keyring compares `iss` byte-for-byte; the token was routed here by its
        // normalized issuer (trailing slash tolerated), so hand it the token's own
        // spelling and enforce the normalized equality on the VERIFIED claims below.
        r = await this.keyring(fed).verify(assertion, { audience, issuer: unverified.iss });
      } catch {
        lastReason = 'jwks-unavailable';
        continue;
      }
      if (!r.ok) {
        lastReason = r.reason as FederationFailure;
        continue;
      }
      if (normalizeIssuer(String(r.claims.iss ?? '')) !== normalizeIssuer(fed.issuer)) {
        lastReason = 'iss';
        continue;
      }
      if (!subjectMatches(fed, r.claims)) {
        lastReason = 'subject-mismatch';
        continue;
      }
      verified = { fed, claims: r.claims };
      break;
    }
    if (!verified) return fail(lastReason);
    const { fed, claims } = verified;

    // Freshness: a workload token is minted for this exchange.
    if (typeof claims.iat !== 'number') return fail('iat-missing');
    if (claims.iat > nowSec + ASSERTION_SKEW_SECONDS) return fail('iat-future');
    if (nowSec - claims.iat > MAX_ASSERTION_AGE_SECONDS + ASSERTION_SKEW_SECONDS) {
      return fail('iat-stale');
    }

    // Replay: remember the assertion until it would have expired anyway.
    const jti =
      typeof claims.jti === 'string' && claims.jti.length > 0
        ? claims.jti
        : `sig:${createHash('sha256').update(assertion).digest('hex')}`;
    const replayKey = `${normalizeIssuer(fed.issuer)}|${jti}`;
    if (this.replay.has(replayKey, nowMs)) return fail('replayed');
    const expMs =
      typeof claims.exp === 'number'
        ? (claims.exp + ASSERTION_SKEW_SECONDS) * 1000
        : nowMs + (MAX_ASSERTION_AGE_SECONDS + ASSERTION_SKEW_SECONDS) * 1000;
    this.replay.add(replayKey, expMs, nowMs);

    const sub = String(claims.sub);
    const ttl = Math.min(
      Math.max(1, Math.floor(fed.ttlSeconds ?? DEFAULT_FEDERATION_TTL_SECONDS)),
      MAX_FEDERATION_TTL_SECONDS,
    );
    return ok({
      federation: fed.name,
      subject: sub,
      principalId: servicePrincipalId(fed.name, sub),
      displayName: (fed.displayName ?? `${fed.name}: ${sub}`).slice(0, 256),
      orgId: fed.orgId,
      workspaceId: fed.workspaceId,
      scope: {
        allowedProviders: fed.scope?.allowedProviders ?? '*',
        allowedModels: fed.scope?.allowedModels ?? '*',
        ...(fed.scope?.groups ? { groups: fed.scope.groups } : {}),
      },
      ttlSeconds: ttl,
      onBehalfOf: fed.onBehalfOf === true,
      claims,
    });
  }
}
