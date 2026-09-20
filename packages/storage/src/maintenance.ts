import { sql } from 'drizzle-orm';
import { affectedRows } from './affected-rows';
import type { Database } from './db';

/**
 * Advisory-lock ids for the maintenance sweeps, so a fleet of replicas does not run
 * the same DELETE in lock-step (row-lock contention, wasted work). One id per job;
 * the lock is transaction-scoped (auto-released at commit), so a crashed replica can
 * never wedge it. Kept in one place to avoid accidental collisions.
 */
export const MAINTENANCE_LOCK = {
  cacheSweep: 5138008701,
  maskVaultSweep: 5138008702,
  requestLogRetention: 5138008703,
  oauthEphemera: 5138008704,
} as const;

export interface BatchSweepOptions {
  /** Rows per DELETE statement. Default 5000 — each batch stays well inside the
   *  data-plane statement_timeout even with index/cascade maintenance. */
  batchSize?: number;
  /** Safety cap on rows removed per invocation; a bigger backlog drains over ticks. */
  maxPerRun?: number;
  /** Advisory lock id (see MAINTENANCE_LOCK). When another session holds it the
   *  sweep returns 0 immediately — one replica does the work. */
  lockId?: number;
}

export interface BatchSweepResult {
  removed: number;
  /** True when the run stopped because another replica held the lock. */
  skipped: boolean;
  /** True when the per-run cap was hit (a backlog remains for the next tick). */
  capped: boolean;
}

const DEFAULT_BATCH = 5_000;
const DEFAULT_MAX_PER_RUN = 500_000;

/**
 * Run `deleteBatch` (a DELETE bounded to `batchSize` rows, returning rows removed)
 * repeatedly until the backlog drains or the per-run cap is reached. Each batch is its
 * own short transaction under a transaction-scoped advisory lock, so one statement
 * never holds a long row lock and a competing replica simply skips. Progress is
 * incremental: a batch that lands is committed even if a later batch fails.
 */
export async function sweepInBatches(
  db: Database,
  opts: BatchSweepOptions,
  deleteBatch: (tx: Database, batchSize: number) => Promise<number>,
): Promise<BatchSweepResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const maxPerRun = Math.max(batchSize, opts.maxPerRun ?? DEFAULT_MAX_PER_RUN);
  let removed = 0;
  for (;;) {
    const n: number = await db.transaction(async (tx) => {
      if (opts.lockId !== undefined) {
        const r = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(${opts.lockId}) as locked`,
        )) as unknown as Array<{ locked: boolean }> | { rows?: Array<{ locked: boolean }> };
        const row = Array.isArray(r) ? r[0] : r.rows?.[0];
        if (row && row.locked !== true) return -1;
      }
      return deleteBatch(tx as unknown as Database, batchSize);
    });
    if (n < 0) return { removed, skipped: removed === 0, capped: false };
    removed += n;
    if (n < batchSize) return { removed, skipped: false, capped: false };
    if (removed >= maxPerRun) return { removed, skipped: false, capped: true };
  }
}

/** Delete up to `batchSize` rows of `table` whose `expiresCol` is before `now`, using
 *  the row's physical id (ctid) so no primary-key knowledge is needed. */
export async function deleteExpiredBatch(
  tx: Database,
  table: string,
  expiresCol: string,
  now: Date,
  batchSize: number,
): Promise<number> {
  const res = await tx.execute(
    sql`delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where ${sql.identifier(expiresCol)} < ${now} limit ${batchSize})`,
  );
  return affectedRows(res);
}
