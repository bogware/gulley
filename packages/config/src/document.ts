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

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep structural validation — returns an error path/message, or null if valid.
 * Every org must have `workspaces[]`; every workspace must have `providers[]` and
 * all six entity collections as arrays of `{ name, config }`. Callers MUST run
 * this before reserving a config version so a malformed doc can't half-apply
 * (mutate + gap the version counter) and 500.
 */
export function validateConfigDocument(v: unknown): string | null {
  if (!isConfigDocument(v)) return 'not a gulley/v1 config document';
  const orgs = (v as unknown as { orgs: unknown[] }).orgs;
  for (let oi = 0; oi < orgs.length; oi++) {
    const org = orgs[oi];
    if (!isObj(org) || typeof org['name'] !== 'string')
      return `orgs[${oi}]: name (string) required`;
    if (!Array.isArray(org['workspaces'])) return `orgs[${oi}].workspaces must be an array`;
    const wss = org['workspaces'] as unknown[];
    for (let wi = 0; wi < wss.length; wi++) {
      const ws = wss[wi];
      const p = `orgs[${oi}].workspaces[${wi}]`;
      if (!isObj(ws) || typeof ws['name'] !== 'string') return `${p}: name (string) required`;
      if (!Array.isArray(ws['providers'])) return `${p}.providers must be an array`;
      for (let pi = 0; pi < (ws['providers'] as unknown[]).length; pi++) {
        const prov = (ws['providers'] as unknown[])[pi];
        if (!isObj(prov) || typeof prov['kind'] !== 'string')
          return `${p}.providers[${pi}]: kind required`;
      }
      for (const coll of ENTITY_COLLECTIONS) {
        const arr = ws[coll];
        if (!Array.isArray(arr)) return `${p}.${coll} must be an array`;
        for (let ei = 0; ei < arr.length; ei++) {
          const ent = arr[ei];
          if (!isObj(ent) || typeof ent['name'] !== 'string' || !isObj(ent['config'])) {
            return `${p}.${coll}[${ei}]: { name (string), config (object) } required`;
          }
        }
      }
      if (ws['virtualKeys'] !== undefined && !Array.isArray(ws['virtualKeys'])) {
        return `${p}.virtualKeys must be an array`;
      }
    }
  }
  return null;
}
