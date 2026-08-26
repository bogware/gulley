import type { SecretRef } from '@gulley/core';
import { diffDocuments } from './canonical';
import type {
  ConfigDocument,
  ConfigEntity,
  ConfigKeyMeta,
  ConfigProvider,
  ConfigWorkspace,
} from './document';
import type { AppliedDiff, ConfigStore, ReconcileContext } from './store';

/**
 * A storage-agnostic backend for the config store: the minimal async CRUD the
 * reconcile/export algorithm needs, over orgs → workspaces → providers +
 * name-keyed entity collections. `BackendConfigStore` implements the full
 * `ConfigStore` on top of one of these, so the reconcile LOGIC is written and
 * tested ONCE (against `InMemoryConfigBackend`) and each durable backend only
 * supplies thin per-table primitives.
 */
export type ConfigCollectionKind =
  'route' | 'policy' | 'budget' | 'ratelimit' | 'guardrail' | 'modelalias';

/** doc workspace key → collection kind. Order is the canonical apply order. */
export const DOC_COLLECTIONS: Array<[keyof ConfigWorkspace, ConfigCollectionKind]> = [
  ['routes', 'route'],
  ['policies', 'policy'],
  ['budgets', 'budget'],
  ['rateLimits', 'ratelimit'],
  ['guardrails', 'guardrail'],
  ['modelAliases', 'modelalias'],
];

export interface BackendOrg {
  id: string;
  name: string;
}
export interface BackendWorkspace {
  id: string;
  orgId: string;
  name: string;
}
export interface BackendProvider {
  id: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
}
export interface BackendEntity {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

export interface ConfigBackend {
  listOrgs(): Promise<BackendOrg[]>;
  createOrg(name: string): Promise<BackendOrg>;
  listWorkspaces(orgId: string): Promise<BackendWorkspace[]>;
  createWorkspace(orgId: string, name: string): Promise<BackendWorkspace>;

  listProviders(workspaceId: string): Promise<BackendProvider[]>;
  upsertProvider(
    workspaceId: string,
    p: { kind: string; baseUrl: string | null; enabled: boolean },
  ): Promise<BackendProvider>;
  deleteProvider(id: string): Promise<void>;
  getCredential(providerId: string): Promise<SecretRef | null>;
  setCredential(providerId: string, ref: SecretRef): Promise<void>;
  deleteCredential(providerId: string): Promise<void>;

  listEntities(kind: ConfigCollectionKind, workspaceId: string): Promise<BackendEntity[]>;
  createEntity(
    kind: ConfigCollectionKind,
    workspaceId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<void>;
  updateEntity(
    kind: ConfigCollectionKind,
    id: string,
    config: Record<string, unknown>,
  ): Promise<void>;
  deleteEntity(kind: ConfigCollectionKind, id: string): Promise<void>;

  /** Export-only virtual-key metadata (never touched by reconcile). */
  listKeyMeta(workspaceId: string): Promise<ConfigKeyMeta[]>;

  /** Run `fn` against a transactional view of the backend (all-or-nothing).
   *  In-memory backends may just call `fn(this)`. */
  runInTransaction<T>(fn: (b: ConfigBackend) => Promise<T>): Promise<T>;
}

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Export a deterministic (sorted) document for the given orgs. */
export async function exportWithBackend(
  backend: ConfigBackend,
  orgIds: ReadonlySet<string> | '*',
): Promise<ConfigDocument> {
  const orgs = (await backend.listOrgs())
    .filter((o) => orgIds === '*' || orgIds.has(o.id))
    .sort(byName);

  const outOrgs = [];
  for (const org of orgs) {
    const workspaces = (await backend.listWorkspaces(org.id)).sort(byName);
    const outWs: ConfigWorkspace[] = [];
    for (const ws of workspaces) {
      const providers: ConfigProvider[] = [];
      for (const p of (await backend.listProviders(ws.id)).sort((a, b) =>
        a.kind.localeCompare(b.kind),
      )) {
        const provider: ConfigProvider = { kind: p.kind, baseUrl: p.baseUrl, enabled: p.enabled };
        const cred = await backend.getCredential(p.id);
        if (cred) provider.credential = cred;
        providers.push(provider);
      }
      const coll = async (kind: ConfigCollectionKind): Promise<ConfigEntity[]> =>
        (await backend.listEntities(kind, ws.id))
          .sort(byName)
          .map((e) => ({ name: e.name, config: e.config }));
      outWs.push({
        name: ws.name,
        providers,
        routes: await coll('route'),
        policies: await coll('policy'),
        budgets: await coll('budget'),
        rateLimits: await coll('ratelimit'),
        guardrails: await coll('guardrail'),
        modelAliases: await coll('modelalias'),
        virtualKeys: (await backend.listKeyMeta(ws.id)).sort(byName),
      });
    }
    outOrgs.push({ name: org.name, workspaces: outWs });
  }
  return { apiVersion: 'gulley/v1', orgs: outOrgs };
}

/** May the admin apply every org affected by `desired` (present ∪ removed)? */
export async function authorizeWithBackend(
  backend: ConfigBackend,
  desired: ConfigDocument,
  cx: ReconcileContext,
): Promise<boolean> {
  const current = await backend.listOrgs();
  const idByName = new Map<string, string>();
  for (const o of current) if (!idByName.has(o.name)) idByName.set(o.name, o.id);
  const affected = new Set<string>([
    ...desired.orgs.map((o) => o.name),
    ...current.filter((o) => !desired.orgs.some((d) => d.name === o.name)).map((o) => o.name),
  ]);
  for (const name of affected) {
    const orgId = idByName.get(name);
    const at = orgId ? { orgId } : {};
    if (!(await cx.access.can(cx.admin, 'config:apply', at))) return false;
  }
  return true;
}

/** Upsert-then-prune the document into the backend. Providers reconcile by
 *  `kind`, entities by `name`; virtual keys are never touched. */
export async function reconcileWithBackend(
  backend: ConfigBackend,
  desired: ConfigDocument,
): Promise<AppliedDiff> {
  const before = await exportWithBackend(backend, '*');

  for (const dOrg of desired.orgs) {
    const org =
      (await backend.listOrgs()).find((o) => o.name === dOrg.name) ??
      (await backend.createOrg(dOrg.name));
    for (const dWs of dOrg.workspaces) {
      const ws =
        (await backend.listWorkspaces(org.id)).find((w) => w.name === dWs.name) ??
        (await backend.createWorkspace(org.id, dWs.name));

      // Providers: upsert by kind, prune by absence (cascade drops the credential).
      const desiredKinds = new Set(dWs.providers.map((p) => p.kind));
      for (const existing of await backend.listProviders(ws.id)) {
        if (!desiredKinds.has(existing.kind)) await backend.deleteProvider(existing.id);
      }
      for (const dp of dWs.providers) {
        const p = await backend.upsertProvider(ws.id, {
          kind: dp.kind,
          baseUrl: dp.baseUrl ?? null,
          enabled: dp.enabled,
        });
        // Reconcile the credential too: set it, or CLEAR a stale one when the
        // desired provider omits it (a kept provider must not retain an old ARN).
        if (dp.credential) await backend.setCredential(p.id, dp.credential);
        else await backend.deleteCredential(p.id);
      }

      // Entity collections: delete-by-absence, create-new, update-on-change.
      for (const [docKey, kind] of DOC_COLLECTIONS) {
        const desiredEntities = dWs[docKey] as ConfigEntity[];
        const desiredNames = new Set(desiredEntities.map((e) => e.name));
        const current = await backend.listEntities(kind, ws.id);
        for (const e of current) {
          if (!desiredNames.has(e.name)) await backend.deleteEntity(kind, e.id);
        }
        for (const de of desiredEntities) {
          const cur = current.find((x) => x.name === de.name);
          if (!cur) await backend.createEntity(kind, ws.id, de.name, de.config);
          else if (!sameJson(cur.config, de.config))
            await backend.updateEntity(kind, cur.id, de.config);
        }
      }
      // virtual keys: intentionally untouched (export-only).
    }
  }

  const after = await exportWithBackend(backend, '*');
  return { summary: diffDocuments(before, after) };
}

/** In-memory `ConfigBackend` for tests + the local dev context. Ids are simple
 *  counters; `runInTransaction` runs against `this` (no isolation needed). */
export class InMemoryConfigBackend implements ConfigBackend {
  private seq = 0;
  private readonly orgs: BackendOrg[] = [];
  private readonly workspaces: BackendWorkspace[] = [];
  private readonly providers = new Map<string, BackendProvider & { workspaceId: string }>();
  private readonly credentials = new Map<string, SecretRef>();
  private readonly entities = new Map<
    ConfigCollectionKind,
    Map<string, BackendEntity & { workspaceId: string }>
  >();
  private readonly keyMeta = new Map<string, ConfigKeyMeta[]>();
  private id(): string {
    return `id_${++this.seq}`;
  }
  private coll(kind: ConfigCollectionKind): Map<string, BackendEntity & { workspaceId: string }> {
    let m = this.entities.get(kind);
    if (!m) {
      m = new Map();
      this.entities.set(kind, m);
    }
    return m;
  }

  async listOrgs(): Promise<BackendOrg[]> {
    return this.orgs.map((o) => ({ ...o }));
  }
  async createOrg(name: string): Promise<BackendOrg> {
    const o = { id: this.id(), name };
    this.orgs.push(o);
    return { ...o };
  }
  async listWorkspaces(orgId: string): Promise<BackendWorkspace[]> {
    return this.workspaces.filter((w) => w.orgId === orgId).map((w) => ({ ...w }));
  }
  async createWorkspace(orgId: string, name: string): Promise<BackendWorkspace> {
    const w = { id: this.id(), orgId, name };
    this.workspaces.push(w);
    return { ...w };
  }
  async listProviders(workspaceId: string): Promise<BackendProvider[]> {
    return [...this.providers.values()]
      .filter((p) => p.workspaceId === workspaceId)
      .map(({ workspaceId: _w, ...p }) => p);
  }
  async upsertProvider(
    workspaceId: string,
    p: { kind: string; baseUrl: string | null; enabled: boolean },
  ): Promise<BackendProvider> {
    const found = [...this.providers.values()].find(
      (x) => x.workspaceId === workspaceId && x.kind === p.kind,
    );
    if (found) {
      found.baseUrl = p.baseUrl;
      found.enabled = p.enabled;
      const { workspaceId: _w, ...out } = found;
      return { ...out };
    }
    const created = { id: this.id(), workspaceId, ...p };
    this.providers.set(created.id, created);
    const { workspaceId: _w, ...out } = created;
    return { ...out };
  }
  async deleteProvider(id: string): Promise<void> {
    this.providers.delete(id);
    this.credentials.delete(id);
  }
  async getCredential(providerId: string): Promise<SecretRef | null> {
    return this.credentials.get(providerId) ?? null;
  }
  async setCredential(providerId: string, ref: SecretRef): Promise<void> {
    this.credentials.set(providerId, ref);
  }
  async deleteCredential(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
  async listEntities(kind: ConfigCollectionKind, workspaceId: string): Promise<BackendEntity[]> {
    return [...this.coll(kind).values()]
      .filter((e) => e.workspaceId === workspaceId)
      .map(({ workspaceId: _w, ...e }) => ({ ...e }));
  }
  async createEntity(
    kind: ConfigCollectionKind,
    workspaceId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const id = this.id();
    this.coll(kind).set(id, { id, workspaceId, name, config });
  }
  async updateEntity(
    kind: ConfigCollectionKind,
    id: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const e = this.coll(kind).get(id);
    if (e) e.config = config;
  }
  async deleteEntity(kind: ConfigCollectionKind, id: string): Promise<void> {
    this.coll(kind).delete(id);
  }
  async listKeyMeta(workspaceId: string): Promise<ConfigKeyMeta[]> {
    return (this.keyMeta.get(workspaceId) ?? []).map((k) => ({ ...k }));
  }
  runInTransaction<T>(fn: (b: ConfigBackend) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** A `ConfigStore` over any `ConfigBackend`. Reconcile runs in one transaction. */
export class BackendConfigStore implements ConfigStore {
  constructor(private readonly backend: ConfigBackend) {}
  exportDocument(orgIds: ReadonlySet<string> | '*'): Promise<ConfigDocument> {
    return exportWithBackend(this.backend, orgIds);
  }
  authorize(desired: ConfigDocument, cx: ReconcileContext): Promise<boolean> {
    return authorizeWithBackend(this.backend, desired, cx);
  }
  reconcile(desired: ConfigDocument, _cx: ReconcileContext): Promise<AppliedDiff> {
    return this.backend.runInTransaction((tx) => reconcileWithBackend(tx, desired));
  }
}
