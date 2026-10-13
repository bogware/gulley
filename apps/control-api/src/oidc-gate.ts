import { pkceChallengeS256 } from '@gulley/oauth';
import type { OidcMetadata } from '@gulley/oidc';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mapMemberships, parseRoleMap, type SsoRoleRule } from './sso';

export const FLOW_COOKIE = 'gulley_oidc_flow';

// Cookie helpers live in cookies.ts (shared with the SAML gate); re-exported here so
// existing imports keep working.
export {
  clearCookie,
  type CookieOptions,
  parseCookies,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies';

// --- the login flow state, carried in a signed cookie (stateless across replicas) ---

export interface FlowState {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  exp: number;
}

/** Sign any flow record that carries an `exp` (ms since epoch): the OIDC
 *  {@link FlowState} and the SAML flow share this HMAC envelope. */
export function signFlow<T extends { exp: number }>(secret: string, flow: T): string {
  const body = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyFlow<T extends { exp: number } = FlowState>(
  secret: string,
  token: string,
  nowMs: number,
): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  let flow: T;
  try {
    flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
  if (!flow || typeof flow !== 'object' || typeof flow.exp !== 'number' || nowMs >= flow.exp)
    return null;
  return flow;
}

// --- OIDC request helpers ---

export function buildAuthorizeUrl(
  md: OidcMetadata,
  p: {
    clientId: string;
    redirectUri: string;
    scopes: string;
    state: string;
    nonce: string;
    verifier: string;
  },
): string {
  const u = new URL(md.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', p.scopes);
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', pkceChallengeS256(p.verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(
  md: OidcMetadata,
  p: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    code: string;
    verifier: string;
  },
  fetchImpl: typeof fetch = fetch,
  opts: { timeoutMs?: number; assertAllowed?: (url: string) => void } = {},
): Promise<{ id_token?: string; access_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);
  // The advertised token_endpoint is guarded like any outbound (it receives the client
  // secret), the call is bounded, and a redirect is refused (it would re-target the
  // secret-bearing POST).
  opts.assertAllowed?.(md.token_endpoint);
  const res = await fetchImpl(md.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`);
  return (await res.json()) as { id_token?: string; access_token?: string };
}

// --- group → role mapping (shared with the SAML gate; see sso.ts) ---

/** @deprecated Use {@link SsoRoleRule} — kept as an alias for existing imports. */
export type OidcRoleRule = SsoRoleRule;
export { mapMemberships, parseRoleMap };

/**
 * Collect the identity values used for role mapping, UNION-ing three sources so an
 * OIDC_ROLE_MAP rule can match either an Entra App Role or a security group:
 *   1. `roles` — Entra App Roles (PRIMARY): human-readable, assignable to users or
 *      groups on the Enterprise App, and immune to the >200-group overage.
 *   2. the configured groups claim (OIDC_GROUPS_CLAIM, default `groups`).
 *   3. `groups` — raw security-group values (GUID fallback).
 * Deduped, order-stable.
 */
export function extractGroups(claims: Record<string, unknown>, claimName: string): string[] {
  const out = new Set<string>();
  for (const key of ['roles', claimName, 'groups']) {
    const v = claims[key];
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string') out.add(x);
    } else if (typeof v === 'string') {
      out.add(v);
    }
  }
  return [...out];
}

/**
 * True when Entra returned a groups "overage" indirection (`_claim_names.groups`)
 * instead of the group values — it does this when the principal is in more than
 * ~200 groups. The group values are then NOT in the token; resolving them requires
 * a Graph `memberOf` call. App Roles (the `roles` claim) never overflow, so the
 * recommended mapping avoids this entirely. Callers should surface a clear warning.
 */
export function hasGroupOverage(claims: Record<string, unknown>): boolean {
  const cn = claims['_claim_names'];
  return (
    !!cn &&
    typeof cn === 'object' &&
    !Array.isArray(cn) &&
    'groups' in (cn as Record<string, unknown>)
  );
}
