import { secretRef, type SecretRef } from '@gulley/core';
import {
  BackendConfigStore,
  type BackendEntity,
  type BackendProvider,
  type BackendWorkspace,
  type ConfigBackend,
  type ConfigCollectionKind,
  type ConfigVersionRecord,
  type ConfigVersionStore,
} from '@gulley/config';
import type { ConfigKeyMeta } from '@gulley/config';
import { eq, sql } from 'drizzle-orm';
import type { Database } from './db';
import {
  budget,
  configVersion,
  guardrail,
  modelAlias,
  org,
  provider,
  providerCredential,
  rateLimit,
  route,
  routePolicy,
  smartRoutingPolicy,
  virtualKey,
  workspace,
} from './schema';

/** Resolve one tenant's provider credential reference (ARN) by workspace +
 *  provider kind — for multi-tenant per-tenant upstream credentials. */
export async function resolveProviderCredentialRef(
  db: Database,
  workspaceId: string,
  kind: string,
): Promise<SecretRef | null> {
  const [row] = await db
    .select({ arn: providerCredential.secretArn, version: providerCredential.secretVersion })
    .from(provider)
    .innerJoin(providerCredential, eq(providerCredential.providerId, provider.id))
    .where(sql`${provider.workspaceId} = ${workspaceId} and ${provider.kind} = ${kind}`);
  return row ? secretRef(row.arn, row.version) : null;
}

/** The five identically-shaped jsonb collection tables (id/workspace_id/name/config). */
function jsonbTable(kind: ConfigCollectionKind): typeof route {
  switch (kind) {
    case 'route':
      return route;
    case 'policy':
      return routePolicy as unknown as typeof route;
    case 'ratelimit':
      return rateLimit as unknown as typeof route;
    case 'guardrail':
      return guardrail as unknown as typeof route;
    case 'modelalias':
      return modelAlias as unknown as typeof route;
    case 'smartroutingpolicy':
      return smartRoutingPolicy as unknown as typeof route;
    default:
      throw new Error(`not a jsonb collection: ${kind}`);
  }
}

/**
 * Postgres `ConfigBackend` — thin per-table CRUD over the Drizzle schema. The
 * reconcile/export ALGORITHM lives in `@gulley/config` (tested against the
 * in-memory backend); this only supplies primitives. `budget` is special-cased
 * because it has typed columns (cap/period) and is unique per workspace rather
 * than a name-keyed jsonb collection.
 */
export class PostgresConfigBackend implements ConfigBackend {
  constructor(private readonly db: Database) {}

  async listOrgs() {
    return this.db.select({ id: org.id, name: org.name }).from(org);
  }
  async createOrg(name: string) {
    const [row] = await this.db
      .insert(org)
      .values({ name })
      .returning({ id: org.id, name: org.name });
    return row as { id: string; name: string };
  }
  async listWorkspaces(orgId: string): Promise<BackendWorkspace[]> {
    return this.db
      .select({ id: workspace.id, orgId: workspace.orgId, name: workspace.name })
      .from(workspace)
      .where(eq(workspace.orgId, orgId));
  }
  async createWorkspace(orgId: string, name: string): Promise<BackendWorkspace> {
    const [row] = await this.db
      .insert(workspace)
      .values({ orgId, name })
      .returning({ id: workspace.id, orgId: workspace.orgId, name: workspace.name });
    return row as BackendWorkspace;
  }

  async listProviders(workspaceId: string): Promise<BackendProvider[]> {
    return this.db
      .select({
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        region: provider.region,
        zdr: provider.zdr,
      })
      .from(provider)
      .where(eq(provider.workspaceId, workspaceId));
  }
  async upsertProvider(
    workspaceId: string,
    p: {
      kind: string;
      baseUrl: string | null;
      enabled: boolean;
      region: string | null;
      zdr: boolean;
    },
  ): Promise<BackendProvider> {
    const existing = await this.db
      .select({ id: provider.id })
      .from(provider)
      .where(sql`${provider.workspaceId} = ${workspaceId} and ${provider.kind} = ${p.kind}`);
    if (existing[0]) {
      await this.db
        .update(provider)
        .set({ baseUrl: p.baseUrl, enabled: p.enabled, region: p.region, zdr: p.zdr })
        .where(eq(provider.id, existing[0].id));
      return { id: existing[0].id, ...p };
    }
    const [row] = await this.db
      .insert(provider)
      .values({
        workspaceId,
        kind: p.kind,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        region: p.region,
        zdr: p.zdr,
      })
      .returning({ id: provider.id });
    return { id: (row as { id: string }).id, ...p };
  }
  async deleteProvider(id: string): Promise<void> {
    await this.db.delete(provider).where(eq(provider.id, id));
  }
  async getCredential(providerId: string): Promise<SecretRef | null> {
    const [row] = await this.db
      .select({ arn: providerCredential.secretArn, version: providerCredential.secretVersion })
      .from(providerCredential)
      .where(eq(providerCredential.providerId, providerId));
    return row ? secretRef(row.arn, row.version) : null;
  }
  async setCredential(providerId: string, ref: SecretRef): Promise<void> {
    await this.db
      .insert(providerCredential)
      .values({ providerId, secretArn: ref.secretArn, secretVersion: ref.secretVersion })
      .onConflictDoUpdate({
        target: providerCredential.providerId,
        set: { secretArn: ref.secretArn, secretVersion: ref.secretVersion },
      });
  }
  async deleteCredential(providerId: string): Promise<void> {
    await this.db.delete(providerCredential).where(eq(providerCredential.providerId, providerId));
  }

  async listEntities(kind: ConfigCollectionKind, workspaceId: string): Promise<BackendEntity[]> {
    if (kind === 'budget') {
      const rows = await this.db
        .select({
          id: budget.id,
          name: budget.name,
          cap: budget.capMicroUsd,
          period: budget.periodSeconds,
        })
        .from(budget)
        .where(eq(budget.workspaceId, workspaceId));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        config:
          r.period == null
            ? { capMicroUsd: r.cap }
            : { capMicroUsd: r.cap, periodSeconds: r.period },
      }));
    }
    const t = jsonbTable(kind);
    const rows = await this.db
      .select({ id: t.id, name: t.name, config: t.config })
      .from(t)
      .where(eq(t.workspaceId, workspaceId));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      config: r.config as Record<string, unknown>,
    }));
  }
  async createEntity(
    kind: ConfigCollectionKind,
    workspaceId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (kind === 'budget') {
      // Budget is singular per workspace — upsert so a (structurally-valid but
      // unusual) second budget in the doc overwrites rather than crashing the tx.
      await this.db
        .insert(budget)
        .values({
          workspaceId,
          name,
          capMicroUsd: Number(config['capMicroUsd'] ?? 0),
          periodSeconds: config['periodSeconds'] == null ? null : Number(config['periodSeconds']),
        })
        .onConflictDoUpdate({
          target: budget.workspaceId,
          set: {
            name,
            capMicroUsd: Number(config['capMicroUsd'] ?? 0),
            periodSeconds: config['periodSeconds'] == null ? null : Number(config['periodSeconds']),
          },
        });
      return;
    }
    await this.db.insert(jsonbTable(kind)).values({ workspaceId, name, config });
  }
  async updateEntity(
    kind: ConfigCollectionKind,
    id: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (kind === 'budget') {
      await this.db
        .update(budget)
        .set({
          capMicroUsd: Number(config['capMicroUsd'] ?? 0),
          periodSeconds: config['periodSeconds'] == null ? null : Number(config['periodSeconds']),
        })
        .where(eq(budget.id, id));
      // Note: name is not updated here — reconcile only calls updateEntity when
      // the config CHANGED for the same name, so the name is already correct.
      return;
    }
    const t = jsonbTable(kind);
    await this.db.update(t).set({ config }).where(eq(t.id, id));
  }
  async deleteEntity(kind: ConfigCollectionKind, id: string): Promise<void> {
    if (kind === 'budget') {
      await this.db.delete(budget).where(eq(budget.id, id));
      return;
    }
    const t = jsonbTable(kind);
    await this.db.delete(t).where(eq(t.id, id));
  }

  async listKeyMeta(workspaceId: string): Promise<ConfigKeyMeta[]> {
    return this.db
      .select({
        name: virtualKey.name,
        keyPrefix: virtualKey.keyPrefix,
        disabled: virtualKey.disabled,
      })
      .from(virtualKey)
      .where(eq(virtualKey.workspaceId, workspaceId));
  }

  runInTransaction<T>(fn: (b: ConfigBackend) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PostgresConfigBackend(tx as unknown as Database)));
  }

  // --- console primitives (id-addressed, bulk reads) ---------------------------
  // The admin console edits ONE row at a time and keeps an in-memory read model of the
  // whole config; these complement the name-keyed reconcile primitives above. They are
  // deliberately not on the ConfigBackend interface (reconcile never needs them).

  /** Every provider row with its workspace (one query, for the read-model hydrate). */
  async listAllProviders(): Promise<Array<BackendProvider & { workspaceId: string }>> {
    return this.db
      .select({
        id: provider.id,
        workspaceId: provider.workspaceId,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        region: provider.region,
        zdr: provider.zdr,
      })
      .from(provider);
  }

  /** Every credential REFERENCE (never a value), keyed by provider id. */
  async listAllCredentials(): Promise<Array<{ providerId: string; ref: SecretRef }>> {
    const rows = await this.db
      .select({
        providerId: providerCredential.providerId,
        arn: providerCredential.secretArn,
        version: providerCredential.secretVersion,
      })
      .from(providerCredential);
    return rows.map((r) => ({ providerId: r.providerId, ref: secretRef(r.arn, r.version) }));
  }

  /** Every entity of one kind across all workspaces (one query per kind). */
  async listAllEntities(
    kind: ConfigCollectionKind,
  ): Promise<Array<BackendEntity & { workspaceId: string }>> {
    if (kind === 'budget') {
      const rows = await this.db
        .select({
          id: budget.id,
          workspaceId: budget.workspaceId,
          name: budget.name,
          cap: budget.capMicroUsd,
          period: budget.periodSeconds,
        })
        .from(budget);
      return rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        config:
          r.period == null
            ? { capMicroUsd: r.cap }
            : { capMicroUsd: r.cap, periodSeconds: r.period },
      }));
    }
    const t = jsonbTable(kind);
    const rows = await this.db
      .select({ id: t.id, workspaceId: t.workspaceId, name: t.name, config: t.config })
      .from(t);
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      config: r.config as Record<string, unknown>,
    }));
  }

  /** Create one entity and return its id (budget: the workspace's singular row). */
  async createEntityReturning(
    kind: ConfigCollectionKind,
    workspaceId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<string> {
    await this.createEntity(kind, workspaceId, name, config);
    const rows = await this.listEntities(kind, workspaceId);
    const row = kind === 'budget' ? rows[0] : rows.find((r) => r.name === name);
    return row?.id ?? '';
  }

  /** Update name and/or config of one entity by id; false when no such row. */
  async updateEntityById(
    kind: ConfigCollectionKind,
    id: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ): Promise<boolean> {
    if (kind === 'budget') {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set['name'] = patch.name;
      if (patch.config) {
        set['capMicroUsd'] = Number(patch.config['capMicroUsd'] ?? 0);
        set['periodSeconds'] =
          patch.config['periodSeconds'] == null ? null : Number(patch.config['periodSeconds']);
      }
      if (Object.keys(set).length === 0) return true;
      const rows = await this.db
        .update(budget)
        .set(set)
        .where(eq(budget.id, id))
        .returning({ id: budget.id });
      return rows.length > 0;
    }
    const t = jsonbTable(kind);
    const set: { name?: string; config?: Record<string, unknown> } = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.config) set.config = patch.config;
    if (Object.keys(set).length === 0) return true;
    const rows = await this.db.update(t).set(set).where(eq(t.id, id)).returning({ id: t.id });
    return rows.length > 0;
  }

  /** Delete one entity by id; false when no such row. */
  async deleteEntityById(kind: ConfigCollectionKind, id: string): Promise<boolean> {
    const t = kind === 'budget' ? budget : jsonbTable(kind);
    const rows = await this.db.delete(t).where(eq(t.id, id)).returning({ id: t.id });
    return rows.length > 0;
  }

  /** Enable/disable or re-point one provider by id; the row, or undefined. */
  async updateProviderById(
    id: string,
    patch: { enabled?: boolean; baseUrl?: string | null },
  ): Promise<(BackendProvider & { workspaceId: string }) | undefined> {
    const set: { enabled?: boolean; baseUrl?: string | null } = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    const rows =
      Object.keys(set).length === 0
        ? await this.db.select().from(provider).where(eq(provider.id, id))
        : await this.db.update(provider).set(set).where(eq(provider.id, id)).returning();
    const r = rows[0];
    return r
      ? {
          id: r.id,
          workspaceId: r.workspaceId,
          kind: r.kind,
          baseUrl: r.baseUrl,
          enabled: r.enabled,
          region: r.region,
          zdr: r.zdr,
        }
      : undefined;
  }

  /** Delete one provider by id (its credential cascades); false when no such row. */
  async deleteProviderById(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(provider)
      .where(eq(provider.id, id))
      .returning({ id: provider.id });
    return rows.length > 0;
  }
}

/** Durable `ConfigStore` over Postgres — reconcile runs in one transaction. */
export class PostgresConfigStore extends BackendConfigStore {
  constructor(db: Database) {
    super(new PostgresConfigBackend(db));
  }
}

/**
 * Postgres `ConfigVersionStore` over the append-only `config_version` table.
 * `tryReserve` inserts a placeholder row for `expected+1` ONLY when the current
 * max is `expected` (the optimistic-concurrency gate: the PK on `version` +
 * the max guard make exactly one concurrent apply win); `append` upserts the
 * real record onto that reserved row.
 */
export class PostgresConfigVersionStore implements ConfigVersionStore {
  constructor(private readonly db: Database) {}

  async currentVersion(): Promise<number> {
    const [row] = await this.db
      .select({ v: sql<number>`coalesce(max(${configVersion.version}), 0)` })
      .from(configVersion);
    return Number(row?.v ?? 0);
  }

  async current(): Promise<ConfigVersionRecord | null> {
    const [row] = await this.db
      .select()
      .from(configVersion)
      .orderBy(sql`${configVersion.version} desc`)
      .limit(1);
    if (!row) return null;
    return {
      version: row.version,
      contentHash: row.contentHash,
      yaml: row.yaml,
      actor: row.actor,
      summary: row.summary as ConfigVersionRecord['summary'],
      auditSeq: Number(row.auditSeq),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async tryReserve(expected: number): Promise<number | null> {
    // Pure read — NEVER a placeholder row (which would leak on a failed apply and
    // surface as a blank "current" version). `append` is the atomic gate: the
    // config_version PK on `version` means a concurrent apply at the same base
    // loses on its INSERT (a 500, not corruption). Note: reconcile + append are
    // not one transaction (apply.ts orchestrates separate deps), so a rare
    // same-base race can leave the loser's reconcile applied without a version
    // row — the audit chain + content hash still catch it.
    const current = await this.currentVersion();
    return current === expected ? expected + 1 : null;
  }

  async append(rec: ConfigVersionRecord): Promise<void> {
    // Plain insert: the version PK is the concurrency gate — a duplicate version
    // (lost race) throws rather than silently overwriting the winner's record.
    await this.db.insert(configVersion).values({
      version: rec.version,
      contentHash: rec.contentHash,
      yaml: rec.yaml,
      actor: rec.actor,
      summary: rec.summary,
      auditSeq: rec.auditSeq,
    });
  }

  async history(limit: number): Promise<ConfigVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(configVersion)
      .orderBy(sql`${configVersion.version} desc`)
      .limit(limit);
    return rows.map((row) => ({
      version: row.version,
      contentHash: row.contentHash,
      yaml: row.yaml,
      actor: row.actor,
      summary: row.summary as ConfigVersionRecord['summary'],
      auditSeq: Number(row.auditSeq),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
