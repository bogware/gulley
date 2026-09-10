import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAuditSink, readAuditRows } from './adapters';
import type { Database } from './db';
import * as schema from './schema';

let client: PGlite;
let db: Database;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (let stmt of readFileSync(`${dir}/${f}`, 'utf8').split('--> statement-breakpoint')) {
      stmt = stmt.trim();
      if (!stmt) continue;
      if (/create extension.*vector/i.test(stmt)) continue;
      if (/using hnsw/i.test(stmt)) continue;
      if (/::vector/i.test(stmt)) continue;
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
});

afterAll(async () => {
  await client.close();
});

describe('readAuditRows sinceSeq lower bound (real SQL via pglite)', () => {
  it('returns the full chain by default and only the tail past sinceSeq when bounded', async () => {
    const sink = new PostgresAuditSink(db);
    for (let i = 1; i <= 5; i++) {
      await sink.append({
        orgId: null,
        actor: 'a',
        action: `act.${i}`,
        target: `t${i}`,
        payload: {},
      });
    }

    const full = await readAuditRows(db);
    expect(full.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]); // complete chain, seq-ascending

    // Tail from a cursor: only rows strictly past it (the WORM/SIEM incremental read),
    // identical to the old read-then-JS-filter because seq is monotonic + committed-only.
    const tail = await readAuditRows(db, 3);
    expect(tail.map((r) => r.seq)).toEqual([4, 5]);
    expect(tail[0]?.action).toBe('act.4');

    // A cursor at/after the head returns nothing (steady-state tick, no new rows).
    expect(await readAuditRows(db, 5)).toHaveLength(0);
  });
});
