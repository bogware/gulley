import type { AuthMode } from '@gulley/core';

/** What a principal is allowed to reach. Resolved uniformly for every auth mode. */
export interface Scope {
  orgId: string;
  workspaceId: string;
  /** Allowed provider kinds, or '*' for all. */
  allowedProviders: readonly string[] | '*';
  /** Allowed model ids/aliases, or '*' for all. */
  allowedModels: readonly string[] | '*';
}

export interface Principal {
  kind: 'virtual-key' | 'oauth-broker' | 'passthrough';
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
