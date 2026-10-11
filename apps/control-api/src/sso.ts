import { signAdminSession } from '@gulley/auth';
import { isRoleId, type Membership, type Role } from '@gulley/rbac';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { ControlContext } from './context';
import { clearCookie, serializeCookie, SESSION_COOKIE } from './cookies';

/**
 * Helpers shared by the browser SSO gates (OIDC in `oidc-routes.ts`, SAML in
 * `saml-routes.ts`): the group → role map, the post-login redirect guard, and the
 * session-minting tail that turns a verified identity into an admin-session cookie.
 */

// --- group → role mapping (OIDC_ROLE_MAP / SAML_ROLE_MAP share one format) ---

export interface SsoRoleRule {
  /** The IdP value to match: an Entra App Role, a security group id/name, a SAML
   *  group attribute value. */
  group: string;
  /** A role id — a built-in name or a custom role id. The id's syntax is validated
   *  here; whether it resolves to permissions is decided at check time (an unknown
   *  id grants nothing). */
  role: Role;
  /** Org to grant the role in; "*" expands to every existing org. */
  orgId: string;
}

export function parseRoleMap(json: string): SsoRoleRule[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (r): r is SsoRoleRule =>
      !!r &&
      typeof (r as SsoRoleRule).group === 'string' &&
      isRoleId((r as SsoRoleRule).role) &&
      typeof (r as SsoRoleRule).orgId === 'string',
  );
}

export function mapMemberships(
  groups: string[],
  rules: SsoRoleRule[],
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

/** A post-login destination is honoured only as a same-origin path (`/x?y`), never
 *  an absolute or scheme-relative URL — the console passes its current page so a deep
 *  link (e.g. the device-consent page with its code) survives the SSO round trip. */
export function safeReturnTo(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (/[\r\n]/.test(raw)) return fallback;
  return raw;
}

// --- the session-minting tail ---

export interface SsoLogin {
  /** The stable admin subject (the configured claim / attribute). */
  subject: string;
  name: string;
  email: string | null;
  memberships: Membership[];
  source: 'oidc' | 'saml';
  cookieSecure: boolean;
  /** Requested destination (validated again here) and the configured fallback. */
  returnTo: unknown;
  fallbackRedirect: string;
  /** Audit action (`admin.session.oidc` / `admin.session.saml`) + extra payload. */
  auditAction: string;
  auditPayload?: Record<string, unknown>;
  /** Flow cookies to clear alongside setting the session cookie. */
  clearCookies?: readonly string[];
  log: FastifyBaseLogger;
}

/**
 * Mint the admin session for a verified SSO identity: sign the session token, record
 * it for revocation, upsert the subject into the durable admin directory (best-effort),
 * append the audit row, set the session cookie (clearing the flow cookie) and redirect
 * to the validated return path. Shared by the OIDC callback and the SAML ACS so both
 * gates produce identical sessions.
 */
export async function completeSsoLogin(
  ctx: ControlContext,
  reply: FastifyReply,
  login: SsoLogin,
): Promise<FastifyReply> {
  const secret = ctx.resolverDeps.sessionSecrets[0];
  if (!secret) {
    return reply.code(500).send({ error: { type: login.source, message: 'no session secret' } });
  }
  const now = ctx.resolverDeps.now ?? Date.now();
  const ttlSec = Math.floor(ctx.resolverDeps.maxSessionTtlMs / 1000);
  const iat = Math.floor(now / 1000);
  const jti = randomUUID();
  const token = signAdminSession(secret, {
    sub: login.subject,
    name: login.name,
    jti,
    memberships: login.memberships,
    iat,
    exp: iat + ttlSec,
    typ: 'admin-session',
    ver: 1,
    src: login.source,
  });
  await ctx.sessions.record?.({
    jti,
    subject: login.subject,
    source: login.source,
    createdAt: new Date(iat * 1000).toISOString(),
    expiresAt: new Date((iat + ttlSec) * 1000).toISOString(),
  });

  // Persist the SSO principal into the durable admin-user directory so it is one
  // identity across SSO, RBAC, SCIM, and the console — and so a SCIM/admin grant
  // (unioned in by membershipLoader) applies, and a SCIM/Graph deprovision can
  // deactivate it. Best-effort: a directory hiccup must not block login.
  if (ctx.adminUsers) {
    try {
      await ctx.adminUsers.upsertBySubject(login.subject, login.name, login.email);
    } catch (e) {
      login.log.warn(
        { err: (e as Error).message, source: login.source },
        'SSO login: admin-user upsert failed',
      );
    }
  }

  await ctx.audit.append({
    orgId: null,
    actor: login.subject,
    action: login.auditAction,
    target: login.subject,
    payload: { jti, memberships: login.memberships.length, ...(login.auditPayload ?? {}) },
  });

  reply.header('set-cookie', [
    serializeCookie(SESSION_COOKIE, token, { secure: login.cookieSecure, maxAge: ttlSec }),
    ...(login.clearCookies ?? []).map((name) => clearCookie(name, { secure: login.cookieSecure })),
  ]);
  // Re-validated on the way out too (the flow state is signed, but defence in depth).
  return reply.redirect(safeReturnTo(login.returnTo, login.fallbackRedirect));
}
