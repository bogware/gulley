import type { SecretRef } from '@gulley/core';

/** A workspace-scoped config entity (route / policy / budget / rate-limit /
 *  guardrail / model-alias). Keyed by `name` in the document (GitOps-friendly). */
export interface ConfigEntity {
  name: string;
  config: Record<string, unknown>;
}

/** A provider. `credential` is a REFERENCE only (Secrets Manager ARN+version). */
export interface ConfigProvider {
  kind: string;
  baseUrl?: string | null;
  enabled: boolean;
  credential?: SecretRef;
}

/** Virtual keys are EXPORT-ONLY — the document carries metadata (never the token
 *  or hash) and reconcile never creates/updates/deletes them. */
export interface ConfigKeyMeta {
  name: string;
  keyPrefix: string;
  disabled: boolean;
}

export interface ConfigWorkspace {
  name: string;
  providers: ConfigProvider[];
  routes: ConfigEntity[];
  policies: ConfigEntity[];
  budgets: ConfigEntity[];
  rateLimits: ConfigEntity[];
  guardrails: ConfigEntity[];
  modelAliases: ConfigEntity[];
  virtualKeys: ConfigKeyMeta[];
}

export interface ConfigOrg {
  name: string;
  workspaces: ConfigWorkspace[];
}

export interface ConfigDocument {
  apiVersion: 'gulley/v1';
  orgs: ConfigOrg[];
}

export function emptyDocument(): ConfigDocument {
  return { apiVersion: 'gulley/v1', orgs: [] };
}

/** The workspace-collection keys reconcile treats uniformly. */
export const ENTITY_COLLECTIONS = [
  'routes',
  'policies',
  'budgets',
  'rateLimits',
  'guardrails',
  'modelAliases',
] as const;
export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

/** Shallow structural validation of a parsed document. */
export function isConfigDocument(v: unknown): v is ConfigDocument {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['apiVersion'] === 'gulley/v1' && Array.isArray(o['orgs']);
}
