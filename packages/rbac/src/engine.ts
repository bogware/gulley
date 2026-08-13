import { type Permission, PERMISSIONS_BY_ROLE } from './permissions';
import { type AdminPrincipal, type Membership, roleRank, type ScopeRef } from './principal';

/** Does a membership cover the given scope? An org-scoped membership covers all
 *  workspaces in that org; the '*' sentinel covers everything. */
export function covers(m: Membership, at: ScopeRef): boolean {
  if (m.orgId === '*') return true;
  if (!at.orgId) return false; // a scoped permission needs an org context
  if (m.orgId !== at.orgId) return false;
  if (m.workspaceId == null) return true; // org-wide membership
  return at.workspaceId != null && m.workspaceId === at.workspaceId;
}

/** Fail-closed check: some membership must both cover `at` and grant `perm`. */
export function can(p: AdminPrincipal, perm: Permission, at: ScopeRef): boolean {
  for (const m of p.memberships) {
    if (covers(m, at) && PERMISSIONS_BY_ROLE[m.role].has(perm)) return true;
  }
  return false;
}

/** Highest role rank the principal holds that covers `at` (−1 if none). Used to
 *  forbid granting a role above one's own at a scope (no amplification). */
export function maxRankAt(p: AdminPrincipal, at: ScopeRef): number {
  let max = -1;
  for (const m of p.memberships) if (covers(m, at)) max = Math.max(max, roleRank[m.role]);
  return max;
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
