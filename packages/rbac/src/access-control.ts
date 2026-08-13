import { can } from './engine';
import type { Permission } from './permissions';
import type { AdminPrincipal, ScopeRef } from './principal';

/** Async permission port so a Postgres-backed impl can load memberships on
 *  demand. Fail-closed: any error (or a missing membership) is a deny. */
export interface AccessControl {
  can(p: AdminPrincipal, perm: Permission, at: ScopeRef): Promise<boolean>;
}

/** Memberships-on-principal impl (the principal already carries its grants). */
export class InMemoryAccessControl implements AccessControl {
  async can(p: AdminPrincipal, perm: Permission, at: ScopeRef): Promise<boolean> {
    try {
      return can(p, perm, at);
    } catch {
      return false;
    }
  }
}
