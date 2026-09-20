import { err, ok, type Result } from '@gulley/core';
import { type AdminPrincipal, isRole, type Membership } from '@gulley/rbac';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How a session was minted. `exchange` = an admin delegated a scoped token
 *  (its memberships are the whole authority — the durable loader is NOT unioned in,
 *  so a delegated token can never widen to the minter's other grants); `oidc` = SSO
 *  login; `break-glass` = the audited bootstrap elevation. Tokens minted before this
 *  claim existed carry none and resolve as `legacy`. */
export type AdminSessionSource = 'exchange' | 'oidc' | 'break-glass' | 'legacy';

export interface AdminSessionClaims {
  /** subject (Entra oid, or the minting admin's own subject for a delegated token). */
  sub: string;
  name: string;
  /** session id — the revocation key. */
  jti: string;
  memberships: Membership[];
  /** seconds since epoch. */
  iat: number;
  exp: number;
  typ: 'admin-session';
  ver: 1;
  /** Mint path (see AdminSessionSource). Optional for backward compatibility. */
  src?: Exclude<AdminSessionSource, 'legacy'>;
}

const PREFIX = 'gses_';

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

/** Mint a signed admin session token: `gses_<base64url(claims)>.<hmac>`. */
export function signAdminSession(secret: string, claims: AdminSessionClaims): string {
  const body = enc(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${PREFIX}${body}.${sig}`;
}

export type AdminSessionFailure =
  | 'not-a-session'
  | 'malformed'
  | 'bad-signature'
  | 'wrong-type'
  | 'ttl-too-long'
  | 'not-yet-valid'
  | 'expired';

export interface VerifyOptions {
  /** now, in ms. */
  now: number;
  /** Reject sessions whose lifetime exceeds this (ms). */
  maxTtlMs: number;
}

export interface VerifiedSession {
  principal: AdminPrincipal;
  jti: string;
  /** Mint path carried in the claims (`legacy` when the token predates the claim). */
  source: AdminSessionSource;
}

/**
 * Verify a session token against any accepted secret (rotation overlap), then —
 * and only then — parse the claims. HMAC is compared constant-time; the TTL is
 * bounded; times are validated. Never throws.
 */
export function verifyAdminSession(
  secrets: readonly string[],
  token: string,
  opts: VerifyOptions,
): Result<VerifiedSession, AdminSessionFailure> {
  if (!token.startsWith(PREFIX)) return err('not-a-session');
  const rest = token.slice(PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return err('malformed');
  const body = rest.slice(0, dot);
  const sigBuf = Buffer.from(rest.slice(dot + 1), 'base64url');

  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(body).digest();
    if (expected.length === sigBuf.length && timingSafeEqual(expected, sigBuf)) {
      matched = true;
      break;
    }
  }
  if (!matched) return err('bad-signature');

  let claims: AdminSessionClaims;
  try {
    claims = JSON.parse(dec(body)) as AdminSessionClaims;
  } catch {
    return err('malformed');
  }
  if (claims.typ !== 'admin-session' || claims.ver !== 1) return err('wrong-type');
  if (
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.jti !== 'string'
  ) {
    return err('malformed');
  }
  if ((claims.exp - claims.iat) * 1000 > opts.maxTtlMs) return err('ttl-too-long');
  const nowSec = Math.floor(opts.now / 1000);
  if (nowSec < claims.iat - 60) return err('not-yet-valid');
  if (nowSec >= claims.exp) return err('expired');

  const memberships = (Array.isArray(claims.memberships) ? claims.memberships : []).filter(
    (m): m is Membership => !!m && isRole((m as Membership).role),
  );
  const source: AdminSessionSource =
    claims.src === 'exchange' || claims.src === 'oidc' || claims.src === 'break-glass'
      ? claims.src
      : 'legacy';
  return ok({
    principal: {
      kind: 'admin',
      subject: claims.sub,
      displayName: claims.name,
      source: 'session',
      memberships,
    },
    jti: claims.jti,
    source,
  });
}
