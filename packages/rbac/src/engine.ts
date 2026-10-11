import type { Permission } from './permissions';
import type { AdminPrincipal, Membership, ScopeRef } from './principal';
import { permissionsOf, type RoleResolver } from './roles';

/** Does a membership cover the given scope? An org-scoped membership covers all
 *  workspaces in that org; the '*' sentinel covers everything. */
export function covers(m: Membership, at: ScopeRef): boolean {
  if (m.orgId === '*') return true;
  if (!at.orgId) return false; // a scoped permission needs an org context
  if (m.orgId !== at.orgId) return false;
  if (m.workspaceId == null) return true; // org-wide membership
  return at.workspaceId != null && m.workspaceId === at.workspaceId;
}

/** Fail-closed check: some membership must both cover `at` and grant `perm`. A
 *  membership whose role id does not resolve (a deleted custom role, a typo in a
 *  role map) grants nothing. */
export function can(
  p: AdminPrincipal,
  perm: Permission,
  at: ScopeRef,
  resolver?: RoleResolver,
): boolean {
  for (const m of p.memberships) {
    if (covers(m, at) && permissionsOf(m.role, resolver).has(perm)) return true;
  }
  return false;
}

/** The union of every permission the principal holds at `at` (across all covering
 *  memberships). */
export function effectivePermissionsAt(
  p: AdminPrincipal,
  at: ScopeRef,
  resolver?: RoleResolver,
): Set<Permission> {
  const out = new Set<Permission>();
  for (const m of p.memberships) {
    if (!covers(m, at)) continue;
    for (const perm of permissionsOf(m.role, resolver)) out.add(perm);
  }
  return out;
}

/**
 * No privilege amplification, as a SUBSET check: a granter may grant `roleId` at
 * `at` only when every permission that role carries is one the granter already
 * holds there. An unknown role is never grantable. This replaces the old rank
 * comparison (which could not order custom roles) and is strictly at least as
 * tight for the built-ins (owner ⊇ admin ⊇ editor ⊇ billing ⊇ viewer).
 */
export function canGrant(
  p: AdminPrincipal,
  roleId: string,
  at: ScopeRef,
  resolver?: RoleResolver,
): boolean {
  const wanted = permissionsOf(roleId, resolver);
  const def = resolver?.get(roleId);
  // A custom role with an empty permission set still has to EXIST to be grantable;
  // a built-in always exists.
  if (wanted.size === 0 && !def) return false;
  const held = effectivePermissionsAt(p, at, resolver);
  for (const perm of wanted) if (!held.has(perm)) return false;
  return true;
}

/** True when some membership — at ANY scope — grants `perm`. For platform-level
 *  reads that every scoped admin needs (e.g. listing the role catalogue before
 *  granting a membership in their own org). Never use it for a write. */
export function canAnywhere(p: AdminPrincipal, perm: Permission, resolver?: RoleResolver): boolean {
  return p.memberships.some((m) => permissionsOf(m.role, resolver).has(perm));
}

/** Does the principal cover this specific workspace? An org-wide membership
 *  covers every workspace in its org; a workspace-scoped membership covers only
 *  its own. List/export handlers must filter by this (not by org alone) so a
 *  workspace-scoped principal never sees sibling-workspace config. */
export function coversWorkspace(p: AdminPrincipal, orgId: string, workspaceId: string): boolean {
  return p.memberships.some((m) => covers(m, { orgId, workspaceId }));
}

/** Org ids the principal can see, or '*' for platform-wide. An empty array means
 *  "see nothing" — list endpoints must filter to this, never fall back to all. */
export function coveredOrgIds(p: AdminPrincipal): readonly string[] | '*' {
  const ids = new Set<string>();
  for (const m of p.memberships) {
    if (m.orgId === '*') return '*';
    ids.add(m.orgId);
  }
  return [...ids];
}
