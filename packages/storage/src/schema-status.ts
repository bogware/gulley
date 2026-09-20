import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Database } from './db';

/** Result of comparing the database's applied migrations with the ones this build
 *  ships. `applied`/`expected` are drizzle's migration timestamps (ms). */
export interface SchemaStatus {
  ok: boolean;
  applied: number | null;
  expected: number | null;
  reason?: string;
}

/** Directory holding this build's migrations (`meta/_journal.json` inside). Defaults
 *  to the workspace copy next to this source; a bundled runtime points
 *  GULLEY_MIGRATIONS_DIR at the copied folder. */
export function migrationsDir(): string {
  return (
    process.env['GULLEY_MIGRATIONS_DIR'] ?? fileURLToPath(new URL('../migrations', import.meta.url))
  );
}

/** The `when` of the newest migration this build ships, or null when the journal
 *  cannot be read (a probe then reports unknown rather than false-negative). */
export function expectedSchemaMillis(dir: string = migrationsDir()): number | null {
  try {
    const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, 'utf8')) as {
      entries?: Array<{ when?: number }>;
    };
    const whens = (journal.entries ?? [])
      .map((e) => e.when)
      .filter((w): w is number => typeof w === 'number');
    return whens.length > 0 ? Math.max(...whens) : null;
  } catch {
    return null;
  }
}

/**
 * Compare the newest row of drizzle's bookkeeping table (`drizzle.__drizzle_migrations`,
 * written by `db:migrate`) with the newest migration this build ships. A database that
 * was never migrated, or that is behind the code, makes the process NOT ready — the
 * failure mode was a boot that looked healthy and then 500'd on the first query that
 * touched a missing column. A database AHEAD of the build (rolling back a deploy) is
 * reported but tolerated.
 */
export async function schemaStatus(
  db: Database,
  expected: number | null = expectedSchemaMillis(),
): Promise<SchemaStatus> {
  let applied: number | null;
  try {
    const res = await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
      created_at?: unknown;
    }>;
    const raw = rows[0]?.created_at;
    applied = raw == null ? null : Number(raw);
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    // 42P01 undefined_table / 3F000 invalid_schema: migrations were never applied.
    if (code === '42P01' || code === '3F000') {
      return {
        ok: false,
        applied: null,
        expected,
        reason: 'migrations never applied (run db:migrate)',
      };
    }
    throw err;
  }
  if (applied === null) {
    return { ok: false, applied, expected, reason: 'migrations never applied (run db:migrate)' };
  }
  if (expected === null) {
    return { ok: true, applied, expected, reason: 'bundled migration journal unavailable' };
  }
  if (applied < expected) {
    return {
      ok: false,
      applied,
      expected,
      reason: 'database schema is behind this build (run db:migrate)',
    };
  }
  if (applied > expected) {
    return { ok: true, applied, expected, reason: 'database schema is ahead of this build' };
  }
  return { ok: true, applied, expected };
}

/**
 * A memoized readiness probe over {@link schemaStatus}: re-checks at most every
 * `ttlMs` (probes are frequent; the answer changes only on a migration), and on a
 * transient query error keeps the last known answer rather than flapping readiness.
 */
export function schemaStatusProbe(
  db: Database,
  opts: { ttlMs?: number; expected?: number | null } = {},
): () => Promise<SchemaStatus> {
  const ttl = opts.ttlMs ?? 30_000;
  const expected = opts.expected === undefined ? expectedSchemaMillis() : opts.expected;
  let last: { at: number; value: SchemaStatus } | undefined;
  let inflight: Promise<SchemaStatus> | undefined;
  return async () => {
    const now = Date.now();
    if (last && now - last.at < ttl) return last.value;
    if (inflight) return inflight;
    inflight = schemaStatus(db, expected)
      .then((value) => {
        last = { at: Date.now(), value };
        return value;
      })
      .catch((err: unknown) => {
        if (last) return last.value;
        return {
          ok: false,
          applied: null,
          expected,
          reason: `schema check failed: ${(err as Error).message}`,
        };
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
