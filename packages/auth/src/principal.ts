import type { AuthMode } from '@gulley/core';

/** What a principal is allowed to reach. Resolved uniformly for every auth mode. */
export interface Scope {
  orgId: string;
  workspaceId: string;
  /** Allowed provider kinds, or '*' for all. */
  allowedProviders: readonly string[] | '*';
  /** Allowed model ids/aliases, or '*' for all. */
  allowedModels: readonly string[] | '*';
  /**
   * Group/team tags the principal belongs to (a lightweight claim/tag, not a
   * managed entity). Sourced from a virtual-key column, an IdP JWT `groups`
   * claim, or a Basic per-user override. Absent ≡ no groups; read via
   * {@link scopeGroups}. Used only for per-group config resolution (e.g. smart
   * routing), never for authz.
   */
  groups?: readonly string[];
}

export interface Principal {
  kind: 'virtual-key' | 'oauth-broker' | 'passthrough' | 'basic';
  /** Stable principal id (e.g. the virtual key's id) — the metering/audit identity. */
  id: string;
  displayName: string;
  authMode: AuthMode;
  scope: Scope;
}

export function scopeAllowsProvider(scope: Scope, provider: string): boolean {
  return scope.allowedProviders === '*' || scope.allowedProviders.includes(provider);
}

export function scopeAllowsModel(scope: Scope, model: string): boolean {
  return scope.allowedModels === '*' || scope.allowedModels.includes(model);
}

/** The principal's groups as a definite list (empty when unset). */
export function scopeGroups(scope: Scope): readonly string[] {
  return scope.groups ?? [];
}
