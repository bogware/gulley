import { can } from './engine';
import type { Permission } from './permissions';
import type { AdminPrincipal, ScopeRef } from './principal';
import type { RoleResolver } from './roles';

/** Async permission port so a Postgres-backed impl can load memberships (or the
 *  role catalogue) on demand. Fail-closed: any error (or a missing membership) is
 *  a deny. */
export interface AccessControl {
  can(p: AdminPrincipal, perm: Permission, at: ScopeRef): Promise<boolean>;
}

/** Memberships-on-principal impl over the BUILT-IN roles only (the principal
 *  already carries its grants; a custom role id grants nothing here). */
export class InMemoryAccessControl implements AccessControl {
  async can(p: AdminPrincipal, perm: Permission, at: ScopeRef): Promise<boolean> {
    try {
      return can(p, perm, at);
    } catch {
      return false;
    }
  }
}

/** A resolver that can refresh itself before a check (a store-backed snapshot). */
export interface RefreshableRoleResolver extends RoleResolver {
  /** Resolve once the snapshot is current enough; must never reject (stale-on-error). */
  ensureFresh?(): Promise<void>;
}

/** Memberships-on-principal impl that resolves custom role ids through a
 *  {@link RoleResolver}. When the resolver is refreshable the snapshot is brought
 *  up to date first, so a role created a moment ago on another replica is honoured
 *  within its TTL. Fail-closed on any error. */
export class RoleAwareAccessControl implements AccessControl {
  constructor(private readonly resolver: RefreshableRoleResolver) {}
  async can(p: AdminPrincipal, perm: Permission, at: ScopeRef): Promise<boolean> {
    try {
      await this.resolver.ensureFresh?.();
      return can(p, perm, at, this.resolver);
    } catch {
      return false;
    }
  }
}
