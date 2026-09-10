import { inArray, lt } from 'drizzle-orm';
import type { Database } from './db';
import { authCode, deviceCode, requestLog } from './schema';

/**
 * Bounded retention / expiry sweeps for the high-write, self-cleaning tables. These run
 * OFF the data-plane hot path on unref'd maintenance timers (like the exact-cache and
 * mask-vault sweeps) and are best-effort: a failure logs and the next tick retries.
 *
 * Scope guardrail: `request_log` is the OPERATIONAL log and is safe to age out, but
 * `spend_ledger` is the durable source of truth from which the Redis budget counters are
 * re-derived and which chargeback/savings reporting reads — it is NEVER swept here.
 * (If it ever needs bounding, that is partitioning/rollup-then-archive, not a DELETE.)
 */

/** Default batch size for the request_log purge — small enough that a single DELETE
 *  never takes a long row-lock, so the sweep can't stall concurrent writes. */
const DEFAULT_REQUEST_LOG_BATCH = 5_000;
/** Safety cap on rows purged per invocation, so one tick can't run unbounded on a huge
 *  backlog; the next tick continues. A large backlog drains over several ticks. */
const DEFAULT_REQUEST_LOG_MAX_PER_RUN = 500_000;

/**
 * Delete `request_log` rows older than `cutoff` in bounded batches. Postgres has no
 * `DELETE ... LIMIT`, so each batch deletes a bounded id set selected by the
 * `request_log_created_idx` index. Returns the total rows removed. Stops when a batch
 * clears fewer than `batchSize` rows (backlog drained) or the per-run cap is hit.
 */
export async function purgeRequestLogsOlderThan(
  db: Database,
  cutoff: Date,
  opts: { batchSize?: number; maxPerRun?: number } = {},
): Promise<number> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_REQUEST_LOG_BATCH);
  const maxPerRun = Math.max(batchSize, opts.maxPerRun ?? DEFAULT_REQUEST_LOG_MAX_PER_RUN);
  let total = 0;
  // Loop bounded batches until the backlog is drained or the per-run cap is reached.
  for (let removed = batchSize; removed >= batchSize && total < maxPerRun;) {
    const victims = await db
      .select({ id: requestLog.id })
      .from(requestLog)
      .where(lt(requestLog.createdAt, cutoff))
      .limit(batchSize);
    if (victims.length === 0) break;
    const res = await db.delete(requestLog).where(
      inArray(
        requestLog.id,
        victims.map((v) => v.id),
      ),
    );
    removed = (res as { rowCount?: number }).rowCount ?? victims.length;
    total += removed;
  }
  return total;
}

/**
 * Delete expired OAuth `device_code` + `auth_code` ephemera (`expires_at < now`). Both
 * already enforce expiry at read/consume time, so this is pure space reclamation for a
 * long-lived broker deployment. Returns rows removed per table.
 */
export async function purgeExpiredOAuthCodes(
  db: Database,
  now: Date = new Date(),
): Promise<{ deviceCodes: number; authCodes: number }> {
  const dc = await db.delete(deviceCode).where(lt(deviceCode.expiresAt, now));
  const ac = await db.delete(authCode).where(lt(authCode.expiresAt, now));
  return {
    deviceCodes: (dc as { rowCount?: number }).rowCount ?? 0,
    authCodes: (ac as { rowCount?: number }).rowCount ?? 0,
  };
}

/** Days → the absolute cutoff instant, for {@link purgeRequestLogsOlderThan}. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}
