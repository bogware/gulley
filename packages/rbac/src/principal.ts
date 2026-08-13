/** Admin roles, least- to most-privileged. Rank enables "no privilege
 *  amplification" checks when granting memberships. */
export type Role = 'viewer' | 'billing' | 'editor' | 'admin' | 'owner';

export const ROLES: readonly Role[] = ['viewer', 'billing', 'editor', 'admin', 'owner'];

export const roleRank: Readonly<Record<Role, number>> = {
  viewer: 0,
  billing: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(roleRank, v);
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
