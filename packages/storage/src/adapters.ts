import type { KeyStore, StoredKey } from '@gulley/auth';
import {
  type AuditEventInput,
  type AuditRow,
  type AuditSink,
  computeRowHash,
  type Ledger,
  type RequestLogEntry,
  type RequestLogSink,
  rowContent,
  type SpendRecord,
} from '@gulley/pipeline';
import { desc, eq, sql } from 'drizzle-orm';
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
    };
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(virtualKey)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(virtualKey.id, id));
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

/**
 * Postgres audit sink. Reads the tail of the chain and appends the next row in
 * one transaction; the unique index on `seq` rejects a racing double-append
 * (caller retries). Full advisory-lock + S3 Object Lock WORM hardening is a
 * later milestone.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly db: Database) {}

  async append(event: AuditEventInput): Promise<AuditRow> {
    return this.db.transaction(async (tx) => {
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
