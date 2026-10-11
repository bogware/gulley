/**
 * A role is referenced by id. The five built-in roles (`viewer` … `owner`) are ids
 * that resolve without a {@link RoleResolver}; a custom role is any other id that an
 * operator created through the control plane (see `roles.ts`). An id that resolves to
 * nothing grants nothing — never an exception.
 */
export type Role = string;

/** The built-in role ids, least- to most-privileged. */
export type BuiltinRole = 'viewer' | 'billing' | 'editor' | 'admin' | 'owner';

export const ROLES: readonly BuiltinRole[] = ['viewer', 'billing', 'editor', 'admin', 'owner'];

const BUILTIN_SET: ReadonlySet<string> = new Set(ROLES);

/** True for one of the five BUILT-IN role names. A custom role id is not a built-in
 *  role; use {@link isRoleId} to accept any well-formed role id. */
export function isRole(v: unknown): v is BuiltinRole {
  return typeof v === 'string' && BUILTIN_SET.has(v);
}

/** Role ids are bounded slugs: lowercase alphanumerics plus `.`, `_`, `-`, 1..64 chars.
 *  Built-in names satisfy it. Used wherever a role id enters from the outside (session
 *  claims, role maps, membership grants) so a malformed value is dropped rather than
 *  carried into a permission check. */
const ROLE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isRoleId(v: unknown): v is Role {
  return typeof v === 'string' && ROLE_ID_RE.test(v);
}

/**
 * A role granted at a scope. An org-scoped membership (no `workspaceId`) covers
 * every workspace in that org. `orgId: '*'` is an IN-MEMORY-ONLY bootstrap
 * sentinel — it is never persisted and never interpolated into a store filter.
 */
export interface Membership {
  role: Role;
  orgId: string | '*';
  workspaceId?: string | null;
}

/** The admin identity (control plane) — distinct from the data-plane Principal
 *  (@gulley/auth) that a virtual key / OAuth token resolves to. */
export interface AdminPrincipal {
  kind: 'admin';
  /** Stable subject (Entra oid, or the bootstrap subject) — the audit identity. */
  subject: string;
  displayName: string;
  source: 'bootstrap' | 'session' | 'entra-session';
  memberships: readonly Membership[];
}

/** Where a permission is being checked. A missing `orgId` means "no org context"
 *  and only the '*' bootstrap membership can satisfy it. */
export interface ScopeRef {
  orgId?: string | null;
  workspaceId?: string | null;
}
