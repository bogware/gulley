import { generateVirtualKey, type InMemoryKeyStore, type StoredKey } from '@gulley/auth';
import type { SecretRef } from '@gulley/core';
import { randomUUID } from 'node:crypto';
import type {
  KeyAdmin,
  KeyView,
  Membership,
  MintedKey,
  MintKeyArgs,
  Org,
  Project,
  Provider,
  ProviderCredential,
  ScopedEntity,
  Workspace,
} from './domain';

const nowIso = (): string => new Date().toISOString();

/**
 * Durable write-through port for the tenancy registries (Postgres in DB mode). The
 * registries below remain the synchronous READ model every route / RBAC scope check
 * uses; with a port attached, `create`/`delete` persist FIRST (so a failure leaves no
 * phantom in-memory row) and `hydrate` reloads the maps from the durable rows at
 * boot and after a config apply. Absent ⇒ pure in-memory (tests, no-DB dev).
 */
export interface TenancyPersistence {
  listOrgs(): Promise<Array<{ id: string; name: string; createdAt: Date }>>;
  listWorkspaces(): Promise<Array<{ id: string; orgId: string; name: string; createdAt: Date }>>;
  insertOrg(row: { id: string; name: string; createdAt: Date }): Promise<void>;
  insertWorkspace(row: { id: string; orgId: string; name: string; createdAt: Date }): Promise<void>;
  deleteOrg(id: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
}

export class OrgStore {
  private readonly byId = new Map<string, Org>();
  constructor(private readonly durable?: TenancyPersistence) {}

  async create(name: string): Promise<Org> {
    const o: Org = { id: randomUUID(), name, createdAt: nowIso() };
    if (this.durable) await this.durable.insertOrg({ ...o, createdAt: new Date(o.createdAt) });
    this.byId.set(o.id, o);
    return o;
  }
  /** Hydration / write-through mirror: upsert a row by id (no persistence call). */
  add(o: Org): void {
    this.byId.set(o.id, { ...o });
  }
  get(id: string): Org | undefined {
    return this.byId.get(id);
  }
  async delete(id: string): Promise<boolean> {
    if (this.durable) await this.durable.deleteOrg(id);
    return this.byId.delete(id);
  }
  list(orgIds: readonly string[] | '*'): Org[] {
    const all = [...this.byId.values()];
    return orgIds === '*' ? all : all.filter((o) => orgIds.includes(o.id));
  }
  /** Replace the in-memory set with the durable rows (a no-op without a port). */
  async hydrate(): Promise<number> {
    if (!this.durable) return this.byId.size;
    const rows = await this.durable.listOrgs();
    this.byId.clear();
    for (const r of rows) {
      this.byId.set(r.id, { id: r.id, name: r.name, createdAt: r.createdAt.toISOString() });
    }
    return this.byId.size;
  }
}

export class WorkspaceStore {
  private readonly byId = new Map<string, Workspace>();
  constructor(private readonly durable?: TenancyPersistence) {}

  async create(orgId: string, name: string): Promise<Workspace> {
    const w: Workspace = { id: randomUUID(), orgId, name, createdAt: nowIso() };
    if (this.durable) {
      await this.durable.insertWorkspace({ ...w, createdAt: new Date(w.createdAt) });
    }
    this.byId.set(w.id, w);
    return w;
  }
  add(w: Workspace): void {
    this.byId.set(w.id, { ...w });
  }
  get(id: string): Workspace | undefined {
    return this.byId.get(id);
  }
  async delete(id: string): Promise<boolean> {
    if (this.durable) await this.durable.deleteWorkspace(id);
    return this.byId.delete(id);
  }
  /** Mirror an org delete's cascade in the read model. */
  deleteByOrg(orgId: string): number {
    let n = 0;
    for (const [id, w] of this.byId) {
      if (w.orgId === orgId) {
        this.byId.delete(id);
        n += 1;
      }
    }
    return n;
  }
  list(orgIds: readonly string[] | '*'): Workspace[] {
    const all = [...this.byId.values()];
    return orgIds === '*' ? all : all.filter((w) => orgIds.includes(w.orgId));
  }
  async hydrate(): Promise<number> {
    if (!this.durable) return this.byId.size;
    const rows = await this.durable.listWorkspaces();
    this.byId.clear();
    for (const r of rows) {
      this.byId.set(r.id, {
        id: r.id,
        orgId: r.orgId,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return this.byId.size;
  }
}

export class ProjectStore {
  private readonly byId = new Map<string, Project>();
  create(workspaceId: string, name: string): Project {
    const p: Project = { id: randomUUID(), workspaceId, name, createdAt: nowIso() };
    this.byId.set(p.id, p);
    return p;
  }
  get(id: string): Project | undefined {
    return this.byId.get(id);
  }
  delete(id: string): boolean {
    return this.byId.delete(id);
  }
  all(): Project[] {
    return [...this.byId.values()];
  }
}

export class MembershipStore {
  private readonly byId = new Map<string, Membership>();
  create(m: Omit<Membership, 'id'>): Membership {
    const row: Membership = { id: randomUUID(), ...m };
    this.byId.set(row.id, row);
    return row;
  }
  delete(id: string): boolean {
    return this.byId.delete(id);
  }
  list(orgIds: readonly string[] | '*'): Membership[] {
    const all = [...this.byId.values()];
    return orgIds === '*' ? all : all.filter((m) => orgIds.includes(m.orgId));
  }
}

export class ProviderStore {
  private readonly byId = new Map<string, Provider>();
  create(p: Omit<Provider, 'id'>): Provider {
    const row: Provider = { id: randomUUID(), ...p };
    this.byId.set(row.id, row);
    return row;
  }
  get(id: string): Provider | undefined {
    return this.byId.get(id);
  }
  update(id: string, patch: Partial<Pick<Provider, 'enabled' | 'baseUrl'>>): Provider | undefined {
    const row = this.byId.get(id);
    if (!row) return undefined;
    const next: Provider = {
      ...row,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
    };
    this.byId.set(id, next);
    return next;
  }
  delete(id: string): boolean {
    return this.byId.delete(id);
  }
  all(): Provider[] {
    return [...this.byId.values()];
  }
}

export class ProviderCredentialStore {
  private readonly byProvider = new Map<string, ProviderCredential>();
  set(providerId: string, credential: SecretRef): ProviderCredential {
    const row: ProviderCredential = { id: randomUUID(), providerId, credential };
    this.byProvider.set(providerId, row);
    return row;
  }
  get(providerId: string): ProviderCredential | undefined {
    return this.byProvider.get(providerId);
  }
}

/** Generic in-memory store for the workspace-scoped config collections. */
export class ScopedCollection {
  private readonly byId = new Map<string, ScopedEntity>();
  create(workspaceId: string, name: string, config: Record<string, unknown>): ScopedEntity {
    const e: ScopedEntity = { id: randomUUID(), workspaceId, name, config };
    this.byId.set(e.id, e);
    return e;
  }
  get(id: string): ScopedEntity | undefined {
    return this.byId.get(id);
  }
  update(
    id: string,
    patch: Partial<Pick<ScopedEntity, 'name' | 'config'>>,
  ): ScopedEntity | undefined {
    const e = this.byId.get(id);
    if (!e) return undefined;
    const next = { ...e, ...patch };
    this.byId.set(id, next);
    return next;
  }
  delete(id: string): boolean {
    return this.byId.delete(id);
  }
  all(): ScopedEntity[] {
    return [...this.byId.values()];
  }
}

/** Mints virtual keys into the shared (data-plane) key store and keeps a
 *  secret-free view for the admin API. Implements {@link KeyAdmin} (in-memory). */
export class KeyAdminStore implements KeyAdmin {
  private readonly views = new Map<string, KeyView & { orgId: string }>();

  constructor(
    private readonly keyStore: InMemoryKeyStore,
    private readonly pepper: string,
  ) {}

  async mint(args: MintKeyArgs): Promise<MintedKey> {
    const gen = generateVirtualKey(this.pepper);
    const id = randomUUID();
    const stored: StoredKey = {
      id,
      keyPrefix: gen.keyPrefix,
      keyHash: gen.keyHash,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      displayName: args.name,
      epoch: 0,
      disabled: false,
      expiresAt: null,
      allowedProviders: args.allowedProviders ?? '*',
      allowedModels: args.allowedModels ?? '*',
    };
    this.keyStore.add(stored);
    this.views.set(id, {
      id,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      name: args.name,
      keyPrefix: gen.keyPrefix,
      disabled: false,
      createdAt: nowIso(),
    });
    return { id, token: gen.token, keyPrefix: gen.keyPrefix };
  }

  async get(id: string): Promise<KeyView | undefined> {
    return this.views.get(id);
  }

  async list(orgIds: readonly string[] | '*'): Promise<KeyView[]> {
    const all = [...this.views.values()];
    return orgIds === '*' ? all : all.filter((v) => orgIds.includes(v.orgId));
  }

  async disable(id: string): Promise<KeyView | undefined> {
    const v = this.views.get(id);
    if (!v) return undefined;
    this.keyStore.disableByPrefix(v.keyPrefix);
    v.disabled = true;
    return v;
  }

  async rotate(id: string): Promise<MintedKey | undefined> {
    const v = this.views.get(id);
    if (!v) return undefined;
    const gen = generateVirtualKey(this.pepper);
    this.keyStore.rekey(v.keyPrefix, gen.keyPrefix, gen.keyHash);
    v.keyPrefix = gen.keyPrefix;
    return { id, token: gen.token, keyPrefix: gen.keyPrefix };
  }
}
