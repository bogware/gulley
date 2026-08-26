import { pkceChallengeS256 } from '@gulley/oauth';
import type { OidcMetadata } from '@gulley/oidc';
import { isRole, type Membership, type Role } from '@gulley/rbac';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'gulley_admin_session';
export const FLOW_COOKIE = 'gulley_oidc_flow';

// --- cookies (no dependency; manual parse/serialize) ---

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  path?: string;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAge: 0 });
}

// --- the login flow state, carried in a signed cookie (stateless across replicas) ---

export interface FlowState {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  exp: number;
}

export function signFlow(secret: string, flow: FlowState): string {
  const body = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyFlow(secret: string, token: string, nowMs: number): FlowState | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  let flow: FlowState;
  try {
    flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FlowState;
  } catch {
    return null;
  }
  if (typeof flow.exp !== 'number' || nowMs >= flow.exp) return null;
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
): Promise<{ id_token?: string; access_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);
  const res = await fetchImpl(md.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`);
  return (await res.json()) as { id_token?: string; access_token?: string };
}

// --- group → role mapping ---

export interface OidcRoleRule {
  group: string;
  role: Role;
  /** Org to grant the role in; "*" expands to every existing org. */
  orgId: string;
}

export function parseRoleMap(json: string): OidcRoleRule[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (r): r is OidcRoleRule =>
      !!r &&
      typeof (r as OidcRoleRule).group === 'string' &&
      isRole((r as OidcRoleRule).role) &&
      typeof (r as OidcRoleRule).orgId === 'string',
  );
}

export function extractGroups(claims: Record<string, unknown>, claimName: string): string[] {
  const v = claims[claimName] ?? claims['groups'] ?? claims['roles'];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' ? [v] : [];
}

export function mapMemberships(
  groups: string[],
  rules: OidcRoleRule[],
  allOrgIds: string[],
): Membership[] {
  const out: Membership[] = [];
  const seen = new Set<string>();
  const add = (role: Role, orgId: string): void => {
    const k = `${role}:${orgId}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ role, orgId, workspaceId: null });
    }
  };
  for (const rule of rules) {
    if (!groups.includes(rule.group)) continue;
    if (rule.orgId === '*') for (const o of allOrgIds) add(rule.role, o);
    else add(rule.role, rule.orgId);
  }
  return out;
}
