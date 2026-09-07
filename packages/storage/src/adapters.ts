import { generateVirtualKey, type KeyStore, type StoredKey } from '@gulley/auth';
import {
  type AuditEventInput,
  type AuditRow,
  type AuditSink,
  computeRowHash,
  decodeLogCursor,
  encodeLogCursor,
  type Ledger,
  type RequestLogEntry,
  type RequestLogFilter,
  type RequestLogPage,
  type RequestLogQuery,
  type RequestLogSink,
  type RequestStatus,
  rowContent,
  type SpendRecord,
  type StoredRequestLog,
  type UsageBucket,
  type UsageQuery,
} from '@gulley/pipeline';
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type { Database } from './db';
import {
  auditLog,
  budget,
  rateLimit,
  requestLog,
  spendLedger,
  virtualKey,
  workspace,
} from './schema';

/** Postgres-backed virtual-key lookup. Route-policy columns (allowed
 *  providers/models) arrive in a later milestone; v1 keys allow all. */
export class PostgresKeyStore implements KeyStore {
  constructor(private readonly db: Database) {}

  async findByPrefix(keyPrefix: string): Promise<StoredKey | null> {
    const rows = await this.db
      .select({
        id: virtualKey.id,
        keyPrefix: virtualKey.keyPrefix,
        keyHash: virtualKey.keyHash,
        workspaceId: virtualKey.workspaceId,
        displayName: virtualKey.name,
        epoch: virtualKey.epoch,
        disabled: virtualKey.disabled,
        expiresAt: virtualKey.expiresAt,
        groups: virtualKey.groups,
        orgId: workspace.orgId,
      })
      .from(virtualKey)
      .innerJoin(workspace, eq(virtualKey.workspaceId, workspace.id))
      .where(eq(virtualKey.keyPrefix, keyPrefix))
      .limit(1);

    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      keyPrefix: r.keyPrefix,
      keyHash: r.keyHash,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      displayName: r.displayName,
      epoch: r.epoch,
      disabled: r.disabled,
      expiresAt: r.expiresAt,
      allowedProviders: '*',
      allowedModels: '*',
      groups: Array.isArray(r.groups)
        ? (r.groups as string[]).filter((g) => typeof g === 'string')
        : [],
    };
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(virtualKey)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(virtualKey.id, id));
  }
}

interface KeyViewRow {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  disabled: boolean;
  createdAt: string;
}
interface MintKeyArgs {
  workspaceId: string;
  orgId: string;
  name: string;
}

/**
 * Durable virtual-key admin over the `virtual_key` table the gateway reads (via
 * {@link PostgresKeyStore}). Unlike the in-memory admin store, mint/disable/rotate
 * here actually take effect on the data plane — a revoke (`disabled=true` + epoch
 * bump) rejects the key on its next lookup, and rotate swaps the secret in place.
 * Structurally satisfies control-api's `KeyAdmin`. */
export class PostgresKeyAdminStore {
  constructor(
    private readonly db: Database,
    private readonly pepper: string,
  ) {}

  private view(r: typeof virtualKey.$inferSelect): KeyViewRow {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      keyPrefix: r.keyPrefix,
      disabled: r.disabled,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async mint(args: MintKeyArgs): Promise<{ id: string; token: string; keyPrefix: string }> {
    const gen = generateVirtualKey(this.pepper);
    const [row] = await this.db
      .insert(virtualKey)
      .values({
        workspaceId: args.workspaceId,
        name: args.name,
        keyPrefix: gen.keyPrefix,
        keyHash: gen.keyHash,
      })
      .returning({ id: virtualKey.id });
    return { id: row?.id ?? '', token: gen.token, keyPrefix: gen.keyPrefix };
  }

  async get(id: string): Promise<KeyViewRow | undefined> {
    const rows = await this.db.select().from(virtualKey).where(eq(virtualKey.id, id)).limit(1);
    return rows[0] ? this.view(rows[0]) : undefined;
  }

  async list(orgIds: readonly string[] | '*'): Promise<KeyViewRow[]> {
    const q = this.db
      .select({ k: virtualKey })
      .from(virtualKey)
      .innerJoin(workspace, eq(virtualKey.workspaceId, workspace.id))
      .orderBy(desc(virtualKey.createdAt));
    const rows = orgIds === '*' ? await q : await q.where(inArray(workspace.orgId, [...orgIds]));
    return rows.map((r) => this.view(r.k));
  }

  async disable(id: string): Promise<KeyViewRow | undefined> {
    const [row] = await this.db
      .update(virtualKey)
      .set({ disabled: true, epoch: sql`${virtualKey.epoch} + 1` })
      .where(eq(virtualKey.id, id))
      .returning();
    return row ? this.view(row) : undefined;
  }

  async rotate(id: string): Promise<{ id: string; token: string; keyPrefix: string } | undefined> {
    const gen = generateVirtualKey(this.pepper);
    const [row] = await this.db
      .update(virtualKey)
      .set({ keyPrefix: gen.keyPrefix, keyHash: gen.keyHash, epoch: sql`${virtualKey.epoch} + 1` })
      .where(eq(virtualKey.id, id))
      .returning({ id: virtualKey.id });
    return row ? { id: row.id, token: gen.token, keyPrefix: gen.keyPrefix } : undefined;
  }
}

export class PostgresLedger implements Ledger {
  constructor(private readonly db: Database) {}

  async record(e: SpendRecord): Promise<void> {
    await this.db.insert(spendLedger).values({
      requestId: e.requestId,
      principalId: e.principalId,
      orgId: e.orgId,
      workspaceId: e.workspaceId,
      provider: e.provider,
      model: e.model,
      status: e.status,
      inputTokens: e.cost.totalInputTokens,
      outputTokens: e.cost.outputTokens,
      costMicroUsd: e.costMicroUsd,
      priced: e.cost.priced,
      createdAt: e.createdAt,
    });
  }
}

function requestLogRow(e: RequestLogEntry): typeof requestLog.$inferInsert {
  return {
    requestId: e.requestId,
    principalId: e.principalId,
    workspaceId: e.workspaceId,
    provider: e.provider,
    model: e.model,
    route: e.route,
    statusCode: e.statusCode,
    status: e.status,
    streamed: e.streamed,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    costMicroUsd: e.costMicroUsd,
    latencyMs: e.latencyMs,
    attributes: e.attributes ?? null,
    createdAt: e.createdAt,
  };
}

export class PostgresRequestLog implements RequestLogSink {
  constructor(private readonly db: Database) {}

  async write(e: RequestLogEntry): Promise<void> {
    await this.db.insert(requestLog).values(requestLogRow(e));
  }

  /** Bulk insert used by the batching writer — one round-trip per flush. */
  async writeBatch(entries: RequestLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(requestLog).values(entries.map(requestLogRow));
  }
}

function toStoredLog(r: typeof requestLog.$inferSelect): StoredRequestLog {
  return {
    id: r.id,
    requestId: r.requestId,
    principalId: r.principalId,
    workspaceId: r.workspaceId ?? '',
    provider: r.provider,
    model: r.model,
    route: r.route,
    statusCode: r.statusCode,
    status: r.status as RequestStatus,
    streamed: r.streamed,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costMicroUsd: r.costMicroUsd,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
    attributes: (r.attributes as Record<string, unknown> | null) ?? undefined,
  };
}

/**
 * Durable READ side of the request log — the admin browser + usage analytics. The
 * gateway writes {@link PostgresRequestLog}; without this the control-api falls back
 * to an empty in-memory store, so the log browser and every cost/usage chart return
 * nothing against real traffic. Search is a keyset page over the
 * `request_log_ws_created_idx` index; usage is a `date_trunc` rollup with error-rate
 * and p95 latency. Mirrors {@link InMemoryRequestLog}'s ordering + bucketing.
 */
export class PostgresRequestLogQuery implements RequestLogQuery {
  constructor(private readonly db: Database) {}

  async search(filter: RequestLogFilter): Promise<RequestLogPage> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const conds: SQL[] = [];
    if (filter.workspaceIds?.length)
      conds.push(inArray(requestLog.workspaceId, [...filter.workspaceIds]));
    if (filter.provider) conds.push(eq(requestLog.provider, filter.provider));
    if (filter.model) conds.push(eq(requestLog.model, filter.model));
    if (filter.status) conds.push(eq(requestLog.status, filter.status));
    if (filter.minStatusCode !== undefined)
      conds.push(gte(requestLog.statusCode, filter.minStatusCode));
    if (filter.from) conds.push(gte(requestLog.createdAt, filter.from));
    if (filter.to) conds.push(lt(requestLog.createdAt, filter.to));
    if (filter.cursor) {
      const c = decodeLogCursor(filter.cursor);
      // Keyset under (created_at desc, id desc); id compared as text so it agrees
      // with the uuid ordering and never mis-casts a foreign cursor.
      if (c)
        conds.push(
          sql`(${requestLog.createdAt} < ${c.createdAt} OR (${requestLog.createdAt} = ${c.createdAt} AND ${requestLog.id}::text < ${c.id}))`,
        );
    }
    const rows = await this.db
      .select()
      .from(requestLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(requestLog.createdAt), desc(requestLog.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(toStoredLog);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeLogCursor(last.createdAt, last.id) : undefined;
    return { entries: page, nextCursor };
  }

  async get(requestId: string): Promise<StoredRequestLog | null> {
    const rows = await this.db
      .select()
      .from(requestLog)
      .where(eq(requestLog.requestId, requestId))
      .orderBy(desc(requestLog.createdAt))
      .limit(1);
    return rows[0] ? toStoredLog(rows[0]) : null;
  }

  async usage(query: UsageQuery): Promise<UsageBucket[]> {
    // A NULL group means "no split" (all rows collapse into one group) — keeps a
    // single fixed query shape regardless of groupBy.
    const groupExpr: SQL =
      query.groupBy === 'provider'
        ? sql`${requestLog.provider}`
        : query.groupBy === 'model'
          ? sql`${requestLog.model}`
          : query.groupBy === 'workspace'
            ? sql`${requestLog.workspaceId}::text`
            : sql`NULL::text`;
    // date_trunc in UTC, formatted to match InMemory's truncate().toISOString().
    const bucketExpr = sql<string>`to_char(date_trunc(${query.bucket}, ${requestLog.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const conds: SQL[] = [
      gte(requestLog.createdAt, query.from),
      lt(requestLog.createdAt, query.to),
    ];
    if (query.workspaceIds?.length)
      conds.push(inArray(requestLog.workspaceId, [...query.workspaceIds]));
    const rows = await this.db
      .select({
        bucketStart: bucketExpr,
        group: groupExpr,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${requestLog.inputTokens}),0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${requestLog.outputTokens}),0)::bigint`,
        costMicroUsd: sql<number>`coalesce(sum(${requestLog.costMicroUsd}),0)::bigint`,
        errors: sql<number>`count(*) FILTER (WHERE ${requestLog.statusCode} >= 400)`,
        p95: sql<number>`coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY ${requestLog.latencyMs}), 0)::int`,
      })
      .from(requestLog)
      .where(and(...conds))
      // Group/order by SELECT position — the bucket expression carries a bound
      // parameter (the trunc unit), so re-stating it in GROUP BY would not match it.
      .groupBy(sql`1`, sql`2`)
      .orderBy(sql`1`, sql`2`);
    return rows.map((r) => {
      const requests = Number(r.requests);
      const group = r.group == null ? undefined : String(r.group);
      return {
        bucketStart: String(r.bucketStart),
        ...(group !== undefined ? { group } : {}),
        requests,
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        costMicroUsd: Number(r.costMicroUsd),
        errorRate: requests ? Number(r.errors) / requests : 0,
        p95LatencyMs: Number(r.p95),
      };
    });
  }
}

/** Fixed advisory-lock key serializing appends to the single audit hash chain.
 *  A stable bigint (not derived at runtime) so every replica contends on the same
 *  lock. */
const AUDIT_CHAIN_LOCK = 5_138_008_617n;

/**
 * Postgres audit sink. Reads the tail of the chain and appends the next row in one
 * transaction, serialized by a transaction-scoped advisory lock so two concurrent
 * appends can't read the same tail and have one silently dropped by the unique
 * `seq` index (a SOC 2 audit-completeness hole). The lock auto-releases on
 * commit/rollback and is held only for the brief read-tail + insert below, so it
 * never gates the request (the append runs in the post-first-byte teardown).
 * S3 Object Lock WORM mirroring of this chain is a later milestone.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly db: Database) {}

  async append(event: AuditEventInput): Promise<AuditRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
      const prev = await tx
        .select({ seq: auditLog.seq, rowHash: auditLog.rowHash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1);

      const prevRow = prev[0];
      const seq = (prevRow?.seq ?? 0) + 1;
      const prevHash = prevRow?.rowHash ?? null;
      const createdAt = new Date();
      const content = rowContent({ seq, createdAt, ...event });
      const rowHash = computeRowHash(prevHash, content);

      await tx.insert(auditLog).values({
        seq,
        orgId: event.orgId ?? null,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        payload: event.payload ?? {},
        prevHash,
        rowHash,
        createdAt,
      });

      return { ...event, seq, prevHash, rowHash, createdAt };
    });
  }
}

/** Read the full audit chain (ordered by seq) for independent verification — the
 *  audit-verify CLI / attestation export. Streaming isn't needed: the chain must be
 *  walked in order anyway, and it is bounded by the deployment's write history. */
export async function readAuditRows(db: Database): Promise<AuditRow[]> {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
  return rows.map((r) => ({
    seq: r.seq,
    orgId: r.orgId,
    actor: r.actor ?? '',
    action: r.action,
    target: r.target,
    payload: (r.payload as Record<string, unknown> | null) ?? {},
    prevHash: r.prevHash,
    rowHash: r.rowHash,
    createdAt: r.createdAt,
  }));
}

/** One rate-limit rule as stored in the `rate_limit.config` JSONB column. */
export interface StoredRateLimitRule {
  id: string;
  limit: number;
  windowSeconds: number;
  unit: 'requests' | 'tokens';
}

/** Reads the active RPM/TPM rules for a workspace for the RateLimiter. Each
 *  rate_limit row's `config` JSONB holds `{ limit, windowSeconds, unit }`;
 *  malformed rows are skipped. Structurally matches @gulley/ratelimit's
 *  RuleResolver without importing it. */
export function createRateLimitResolver(
  db: Database,
): (workspaceId: string) => Promise<StoredRateLimitRule[]> {
  return async (workspaceId) => {
    const rows = await db
      .select({ id: rateLimit.id, config: rateLimit.config })
      .from(rateLimit)
      .where(eq(rateLimit.workspaceId, workspaceId));
    const rules: StoredRateLimitRule[] = [];
    for (const row of rows) {
      const c = row.config as Record<string, unknown>;
      const limit = typeof c['limit'] === 'number' ? c['limit'] : undefined;
      const windowSeconds = typeof c['windowSeconds'] === 'number' ? c['windowSeconds'] : undefined;
      const unit =
        c['unit'] === 'tokens' ? 'tokens' : c['unit'] === 'requests' ? 'requests' : undefined;
      if (
        limit === undefined ||
        limit <= 0 ||
        windowSeconds === undefined ||
        windowSeconds <= 0 ||
        !unit
      ) {
        continue; // skip a misconfigured rule rather than fail the request
      }
      rules.push({ id: row.id, limit, windowSeconds, unit });
    }
    return rules;
  };
}

/** Reads per-workspace budget caps for the RedisBudgetStore. Structurally
 *  matches @gulley/budget's CapResolver without importing it. */
export function createBudgetCapResolver(
  db: Database,
): (workspaceId: string) => Promise<{ capMicroUsd: number; periodSeconds?: number } | null> {
  return async (workspaceId) => {
    const rows = await db
      .select({ cap: budget.capMicroUsd, period: budget.periodSeconds })
      .from(budget)
      .where(eq(budget.workspaceId, workspaceId))
      .limit(1);
    const b = rows[0];
    if (!b) return null;
    return b.period != null
      ? { capMicroUsd: b.cap, periodSeconds: b.period }
      : { capMicroUsd: b.cap };
  };
}
