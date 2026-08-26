import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

/** A JSON Web Key (RSA or EC public key). */
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: string[];
  roles?: string[];
  [k: string]: unknown;
}

export type VerifyFailure =
  'malformed' | 'unsupported-alg' | 'no-matching-key' | 'bad-key' | 'bad-signature';

// Only asymmetric algorithms — HS* (symmetric) is deliberately unsupported here,
// so a JWKS-verified token can never be forged with a shared secret (key confusion).
const ALG_TO_HASH: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
  PS256: 'RSA-SHA256',
  PS384: 'RSA-SHA384',
  PS512: 'RSA-SHA512',
  ES256: 'SHA256',
  ES384: 'SHA384',
  ES512: 'SHA512',
};

function decode(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

export function decodeJwtHeader(jwt: string): JwtHeader | null {
  const dot = jwt.indexOf('.');
  if (dot <= 0) return null;
  try {
    return decode(jwt.slice(0, dot)) as JwtHeader;
  } catch {
    return null;
  }
}

/**
 * Verify a compact JWS against a JWKS. The algorithm comes from the token header
 * but is constrained to the asymmetric set above (no `none`, no HS*). The key is
 * selected by `kid`, falling back to a single key of the matching type. Returns
 * the claims on success — callers MUST still validate iss/aud/exp/nonce.
 */
export function verifyJwtWithJwks(
  jwt: string,
  jwks: Jwk[],
): { ok: true; header: JwtHeader; claims: JwtClaims } | { ok: false; reason: VerifyFailure } {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];

  let header: JwtHeader;
  try {
    header = decode(h) as JwtHeader;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const alg = header.alg;
  if (!alg || !(alg in ALG_TO_HASH)) return { ok: false, reason: 'unsupported-alg' };

  const wantKty = alg.startsWith('ES') ? 'EC' : 'RSA';
  const jwk =
    (header.kid ? jwks.find((k) => k.kid === header.kid) : undefined) ??
    jwks.find((k) => k.kty === wantKty);
  if (!jwk) return { ok: false, reason: 'no-matching-key' };

  let key: KeyObject;
  try {
    key = createPublicKey({
      key: jwk as unknown as import('node:crypto').JsonWebKey,
      format: 'jwk',
    });
  } catch {
    return { ok: false, reason: 'bad-key' };
  }

  try {
    const v = createVerify(ALG_TO_HASH[alg] as string);
    v.update(`${h}.${p}`);
    v.end();
    const opts: Parameters<typeof v.verify>[0] = alg.startsWith('ES')
      ? { key, dsaEncoding: 'ieee-p1363' }
      : alg.startsWith('PS')
        ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: -1 /* DIGEST */ }
        : { key };
    if (!v.verify(opts, Buffer.from(s, 'base64url'))) return { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }

  return { ok: true, header, claims: decode(p) as JwtClaims };
}

export interface ClaimExpectations {
  issuer: string;
  /** Accepted audience(s). */
  audience: string | string[];
  /** Required nonce (OIDC login). Omit to skip. */
  nonce?: string;
  /** Now, in ms. */
  now: number;
  /** Clock skew tolerance in seconds (default 60). */
  skewSeconds?: number;
}

export type ClaimFailure = 'iss' | 'aud' | 'expired' | 'not-yet-valid' | 'nonce';

/** Validate the standard OIDC/JWT claims after a signature check. */
export function validateClaims(
  claims: JwtClaims,
  exp: ClaimExpectations,
): { ok: true } | { ok: false; reason: ClaimFailure } {
  const skew = exp.skewSeconds ?? 60;
  const nowSec = Math.floor(exp.now / 1000);
  if (claims.iss !== exp.issuer) return { ok: false, reason: 'iss' };
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const wanted = Array.isArray(exp.audience) ? exp.audience : [exp.audience];
  if (!auds.some((a) => a !== undefined && wanted.includes(a))) return { ok: false, reason: 'aud' };
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp + skew) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && nowSec < claims.nbf - skew) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (exp.nonce !== undefined && claims.nonce !== exp.nonce) return { ok: false, reason: 'nonce' };
  return { ok: true };
}
