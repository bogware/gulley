import { type Permission, PERMISSIONS_BY_ROLE } from './permissions';
import { type BuiltinRole, isRole, ROLES } from './principal';

/** A role object: an id, a display name, and the permission set it grants. The five
 *  built-ins are seeded definitions (`builtin: true`, id = name) and are immutable;
 *  a custom role is any other definition an operator created. */
export interface RoleDefinition {
  id: string;
  name: string;
  permissions: Permission[];
  builtin: boolean;
  description?: string;
}

const BUILTIN_DESCRIPTIONS: Readonly<Record<BuiltinRole, string>> = {
  viewer: 'Read-only across every resource.',
  billing: 'Read everything; manage budgets.',
  editor: 'Read everything; manage workspace config, keys (mint, disable, rotate) and budgets.',
  admin: 'Editor plus membership grants, custom roles and audit verification.',
  owner: 'Admin plus org lifecycle, owner grants, config apply and the guardrail de-mask reveal.',
};

/** The five built-in roles as seeded {@link RoleDefinition}s (same permission sets as
 *  `PERMISSIONS_BY_ROLE`; ids are their names). */
export const BUILTIN_ROLES: readonly RoleDefinition[] = ROLES.map((id) => ({
  id,
  name: id,
  permissions: [...PERMISSIONS_BY_ROLE[id]].sort(),
  builtin: true,
  description: BUILTIN_DESCRIPTIONS[id],
}));

/** Resolves a role id to its definition. Built-ins resolve without any resolver (see
 *  {@link permissionsOf}); a resolver supplies the custom roles. `get` is synchronous
 *  so the permission engine stays a pure function — an async store memoizes a
 *  snapshot behind this interface. */
export interface RoleResolver {
  get(roleId: string): RoleDefinition | undefined;
}

/** A resolver over a fixed set of definitions (tests, the in-memory control plane).
 *  Built-ins always win over a same-id entry, so a definition can never redefine
 *  `owner`. */
export class StaticRoleResolver implements RoleResolver {
  private readonly byId = new Map<string, RoleDefinition>();
  constructor(roles: readonly RoleDefinition[] = []) {
    for (const r of roles) if (!isRole(r.id)) this.byId.set(r.id, r);
  }
  get(roleId: string): RoleDefinition | undefined {
    return builtinRole(roleId) ?? this.byId.get(roleId);
  }
  set(role: RoleDefinition): void {
    if (!isRole(role.id)) this.byId.set(role.id, role);
  }
  delete(roleId: string): boolean {
    return this.byId.delete(roleId);
  }
  list(): RoleDefinition[] {
    return [...BUILTIN_ROLES, ...this.byId.values()];
  }
}

/** Built-ins only (no custom roles). */
export const builtinRoleResolver: RoleResolver = { get: builtinRole };

export function builtinRole(roleId: string): RoleDefinition | undefined {
  return isRole(roleId) ? BUILTIN_ROLES[ROLES.indexOf(roleId)] : undefined;
}

const EMPTY: ReadonlySet<Permission> = new Set();

/**
 * The permission set a role id grants. A built-in resolves from code (never from the
 * resolver, so a stored row cannot redefine it); a custom id resolves through the
 * resolver; an unknown id — or no resolver — grants NOTHING. Never throws.
 */
export function permissionsOf(roleId: string, resolver?: RoleResolver): ReadonlySet<Permission> {
  if (isRole(roleId)) return PERMISSIONS_BY_ROLE[roleId];
  if (!resolver) return EMPTY;
  try {
    const def = resolver.get(roleId);
    return def ? new Set(def.permissions) : EMPTY;
  } catch {
    return EMPTY;
  }
}
