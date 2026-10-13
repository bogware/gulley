import { and, desc, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';

import type { Database } from './db';
import {
  type BatchSweepOptions,
  type BatchSweepResult,
  deleteExpiredBatch,
  MAINTENANCE_LOCK,
  sweepInBatches,
} from './maintenance';
import { sessionBlock } from './schema';

/** Who placed a block: the runaway-session detector, or an operator. */
export type SessionBlockSource = 'runaway' | 'manual';

export interface SessionBlockRecord {
  workspaceId: string;
  session: string;
  reason: string;
  source: SessionBlockSource;
  createdBy: string;
  createdAt: Date;
  /** null = until unblocked. */
  expiresAt: Date | null;
}

export interface SessionBlockInput {
  workspaceId: string;
  session: string;
  reason: string;
  source: SessionBlockSource;
  createdBy: string;
  /** Seconds until the block lapses on its own; omit for an indefinite block. */
  ttlSeconds?: number;
}

export interface SessionBlockListOptions {
  /** Restrict to these workspaces (RBAC scope). Undefined = every workspace. An
   *  explicit empty list returns nothing. */
  workspaceIds?: string[];
  /** Include rows past their expiry (default false: active blocks only). */
  includeExpired?: boolean;
  limit?: number;
}

/**
 * The session kill switch's durable store: one row per (workspace, session). The
 * control plane writes (detector + console), the gateway reads a snapshot
 * ({@link loadActiveSessionBlocks} / {@link SessionBlockSnapshot}).
 */
export interface SessionBlockStore {
  /** Upsert a block (a re-block refreshes reason/source/expiry). */
  block(input: SessionBlockInput): Promise<SessionBlockRecord>;
  /** Remove a block; false when none existed. */
  unblock(workspaceId: string, session: string): Promise<boolean>;
  list(opts?: SessionBlockListOptions): Promise<SessionBlockRecord[]>;
  /** True while a non-expired block exists. */
  isBlocked(workspaceId: string, session: string): Promise<boolean>;
  /** Reclaim rows past their expiry (expiry is already enforced on read). */
  sweepExpired(now: Date): Promise<number>;
}

const DEFAULT_LIST_LIMIT = 1_000;

function expiryFor(ttlSeconds: number | undefined, now: Date): Date | null {
  return ttlSeconds !== undefined && ttlSeconds > 0
    ? new Date(now.getTime() + ttlSeconds * 1000)
    : null;
}

function activeCond(now: Date): SQL {
  return or(isNull(sessionBlock.expiresAt), gt(sessionBlock.expiresAt, now)) as SQL;
}

/** Postgres-backed {@link SessionBlockStore}. Reads filter out expired rows, so a
 *  lapsed block is invisible even before the sweep reclaims it. */
export class PostgresSessionBlockStore implements SessionBlockStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async block(input: SessionBlockInput): Promise<SessionBlockRecord> {
    const now = this.now();
    const expiresAt = expiryFor(input.ttlSeconds, now);
    const rows = await this.db
      .insert(sessionBlock)
      .values({
        workspaceId: input.workspaceId,
        session: input.session,
        reason: input.reason,
        source: input.source,
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [sessionBlock.workspaceId, sessionBlock.session],
        set: {
          reason: input.reason,
          source: input.source,
          createdBy: input.createdBy,
          createdAt: now,
          expiresAt,
        },
      })
      .returning();
    const r = rows[0];
    if (!r) throw new Error('session_block upsert returned no row');
    return toRecord(r);
  }

  async unblock(workspaceId: string, session: string): Promise<boolean> {
    const rows = await this.db
      .delete(sessionBlock)
      .where(and(eq(sessionBlock.workspaceId, workspaceId), eq(sessionBlock.session, session)))
      .returning({ session: sessionBlock.session });
    return rows.length > 0;
  }

  async list(opts: SessionBlockListOptions = {}): Promise<SessionBlockRecord[]> {
    if (opts.workspaceIds && opts.workspaceIds.length === 0) return [];
    const conds: SQL[] = [];
    if (opts.workspaceIds) conds.push(inArray(sessionBlock.workspaceId, opts.workspaceIds));
    if (!opts.includeExpired) conds.push(activeCond(this.now()));
    const rows = await this.db
      .select()
      .from(sessionBlock)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(sessionBlock.createdAt), sessionBlock.workspaceId, sessionBlock.session)
      .limit(Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, 10_000)));
    return rows.map(toRecord);
  }

  async isBlocked(workspaceId: string, session: string): Promise<boolean> {
    const rows = await this.db
      .select({ session: sessionBlock.session })
      .from(sessionBlock)
      .where(
        and(
          eq(sessionBlock.workspaceId, workspaceId),
          eq(sessionBlock.session, session),
          activeCond(this.now()),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async sweepExpired(now: Date, opts: BatchSweepOptions = {}): Promise<number> {
    return (await this.sweepExpiredDetailed(now, opts)).removed;
  }

  async sweepExpiredDetailed(now: Date, opts: BatchSweepOptions = {}): Promise<BatchSweepResult> {
    return sweepInBatches(this.db, { lockId: MAINTENANCE_LOCK.runawayDetector, ...opts }, (tx, n) =>
      deleteExpiredBatch(tx, 'session_block', 'expires_at', now, n),
    );
  }
}

function toRecord(r: typeof sessionBlock.$inferSelect): SessionBlockRecord {
  return {
    workspaceId: r.workspaceId,
    session: r.session,
    reason: r.reason,
    source: r.source === 'runaway' ? 'runaway' : 'manual',
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? null,
  };
}

/** In-memory {@link SessionBlockStore} for tests and DB-less deployments. */
export class InMemorySessionBlockStore implements SessionBlockStore {
  private readonly rows = new Map<string, SessionBlockRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private key(workspaceId: string, session: string): string {
    return `${workspaceId}\u0000${session}`;
  }

  private live(r: SessionBlockRecord, now: Date): boolean {
    return r.expiresAt === null || r.expiresAt.getTime() > now.getTime();
  }

  async block(input: SessionBlockInput): Promise<SessionBlockRecord> {
    const now = this.now();
    const rec: SessionBlockRecord = {
      workspaceId: input.workspaceId,
      session: input.session,
      reason: input.reason,
      source: input.source,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: expiryFor(input.ttlSeconds, now),
    };
    this.rows.set(this.key(input.workspaceId, input.session), rec);
    return rec;
  }

  async unblock(workspaceId: string, session: string): Promise<boolean> {
    return this.rows.delete(this.key(workspaceId, session));
  }

  async list(opts: SessionBlockListOptions = {}): Promise<SessionBlockRecord[]> {
    if (opts.workspaceIds && opts.workspaceIds.length === 0) return [];
    const now = this.now();
    const scope = opts.workspaceIds ? new Set(opts.workspaceIds) : undefined;
    return [...this.rows.values()]
      .filter((r) => (scope ? scope.has(r.workspaceId) : true))
      .filter((r) => opts.includeExpired || this.live(r, now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit ?? DEFAULT_LIST_LIMIT);
  }

  async isBlocked(workspaceId: string, session: string): Promise<boolean> {
    const r = this.rows.get(this.key(workspaceId, session));
    return r !== undefined && this.live(r, this.now());
  }

  async sweepExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [k, r] of this.rows) {
      if (!this.live(r, now)) {
        this.rows.delete(k);
        n++;
      }
    }
    return n;
  }
}

/** One active block as the gateway snapshot sees it. */
export interface ActiveSessionBlock {
  workspaceId: string;
  session: string;
  expiresAt: Date | null;
}

/** Every non-expired block — the gateway snapshot loader. Bounded: a deployment
 *  with more than 50k simultaneous blocks is misconfigured, not a kill-switch case. */
export async function loadActiveSessionBlocks(
  db: Database,
  now: Date = new Date(),
): Promise<ActiveSessionBlock[]> {
  const rows = await db
    .select({
      workspaceId: sessionBlock.workspaceId,
      session: sessionBlock.session,
      expiresAt: sessionBlock.expiresAt,
    })
    .from(sessionBlock)
    .where(activeCond(now))
    .limit(50_000);
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    session: r.session,
    expiresAt: r.expiresAt ?? null,
  }));
}

/**
 * The gateway's view of the session kill switch: a locally cached set of active
 * blocks, refreshed on an unref'd timer, read synchronously on the request path
 * (`isBlocked` is a Map lookup — never I/O). The first load is awaited by
 * {@link start} so a replica never serves with an empty snapshot it could have
 * filled; a failed refresh keeps the last snapshot (stale-but-safe), so a control-
 * plane database blip can neither lift nor invent a block. Expiry is honoured
 * locally between refreshes so a lapsed block lifts on time without a reload.
 */
export class SessionBlockSnapshot {
  private snapshot = new Map<string, number>(); // key → expires-at epoch ms (Infinity = none)
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastRefreshAt = 0;
  private lastError: unknown;

  constructor(
    private readonly loader: () => Promise<ActiveSessionBlock[]>,
    private readonly refreshMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(workspaceId: string, session: string): string {
    return `${workspaceId}\u0000${session}`;
  }

  isBlocked(workspaceId: string, session: string): boolean {
    const until = this.snapshot.get(this.key(workspaceId, session));
    return until !== undefined && until > this.now();
  }

  /** Number of active blocks in the snapshot (metrics / tests). */
  get size(): number {
    return this.snapshot.size;
  }

  /** Epoch ms of the last successful load (0 = never), and the last load error. */
  get status(): { lastRefreshAt: number; lastError: unknown } {
    return { lastRefreshAt: this.lastRefreshAt, lastError: this.lastError };
  }

  /** One load. Never throws: an error keeps the previous snapshot. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.loader();
      const next = new Map<string, number>();
      const now = this.now();
      for (const r of rows) {
        const until = r.expiresAt ? r.expiresAt.getTime() : Number.POSITIVE_INFINITY;
        if (until > now) next.set(this.key(r.workspaceId, r.session), until);
      }
      this.snapshot = next;
      this.lastRefreshAt = now;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err;
    }
  }

  /** Await the first load, then refresh on an unref'd interval. Idempotent. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
