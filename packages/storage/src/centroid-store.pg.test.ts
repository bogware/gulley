import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centroidSha, PostgresCentroidStore } from './centroid-store';
import type { Database } from './db';
import * as schema from './schema';

// Real SQL via pglite/WASM (no Docker). The classifier_centroid table is jsonb-only
// (no pgvector), so migrations apply cleanly here.
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
      if (/create extension.*vector/i.test(stmt)) continue; // pglite has no pgvector
      if (/using hnsw/i.test(stmt)) continue;
      if (/::vector/i.test(stmt)) continue; // pglite has no ::vector cast (0012 backfill)
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text'); // other tables' vector cols → text
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

describe('PostgresCentroidStore (real SQL via pglite)', () => {
  it('round-trips embeddings and filters load by scope + model', async () => {
    const store = new PostgresCentroidStore(db);
    await store.save('m1', [
      { scope: 'p1', label: 'code', exemplar: 'write a function', embedding: [1, 0, 0] },
      { scope: 'p1', label: 'prose', exemplar: 'tell a story', embedding: [0, 1, 0] },
      { scope: 'p2', label: 'code', exemplar: 'other policy', embedding: [0, 0, 1] },
    ]);
    await store.save('m2', [
      { scope: 'p1', label: 'code', exemplar: 'write a function', embedding: [9, 9, 9] },
    ]);

    const p1 = await store.load(['p1'], 'm1');
    expect(p1).toHaveLength(2); // only p1 rows for model m1 (p2 and m2 excluded)
    const code = p1.find((r) => r.label === 'code');
    expect(code?.embedding).toEqual([1, 0, 0]); // jsonb number[] round-trips exactly
    expect(code?.exemplarSha).toBe(centroidSha('write a function'));

    const both = await store.load(['p1', 'p2'], 'm1');
    expect(both).toHaveLength(3);
    expect(await store.load([], 'm1')).toEqual([]); // empty scope list ⇒ no query
    expect(await store.load(['nope'], 'm1')).toEqual([]);
  });

  it('is idempotent: re-saving the same exemplar does not duplicate the row', async () => {
    const store = new PostgresCentroidStore(db);
    const row = { scope: 'idem', label: 'x', exemplar: 'same text', embedding: [0.5, 0.5] };
    await store.save('m1', [row]);
    await store.save('m1', [row]);
    await store.save('m1', [{ ...row, embedding: [0.9, 0.9] }]); // conflict ⇒ left as-is

    const loaded = await store.load(['idem'], 'm1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.embedding).toEqual([0.5, 0.5]); // first write wins (onConflictDoNothing)
  });
});
