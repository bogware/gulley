import type { SecretRef } from '@gulley/core';
import type { Role } from '@gulley/rbac';

export interface Org {
  id: string;
  name: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  userId: string;
  role: Role;
  orgId: string;
  workspaceId?: string | null;
}

export interface Provider {
  id: string;
  workspaceId: string;
  kind: string;
  baseUrl?: string | null;
  enabled: boolean;
}

/** Only an external reference to the credential — never the value. */
export interface ProviderCredential {
  id: string;
  providerId: string;
  credential: SecretRef;
}

/** A control-plane entity that lives under a workspace (routes, policies,
 *  budgets, rate limits, guardrails, model aliases). Config (M5.3) serializes
 *  these generically. */
export interface ScopedEntity {
  id: string;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
}

export type CollectionKind =
  'route' | 'policy' | 'budget' | 'ratelimit' | 'guardrail' | 'modelalias';

export const COLLECTION_KINDS: readonly CollectionKind[] = [
  'route',
  'policy',
  'budget',
  'ratelimit',
  'guardrail',
  'modelalias',
];

/** A virtual key as the admin API exposes it — never the token or the hash. */
export interface KeyView {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  disabled: boolean;
  createdAt: string;
}
