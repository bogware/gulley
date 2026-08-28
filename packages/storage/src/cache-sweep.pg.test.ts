import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { CachedResponse } from '@gulley/cache';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresExactCache } from './cache-adapters';
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
      stmt = stmt.replace(/vector\(\d+\)/gi, 'text');
      await pg.exec(stmt);
    }
  }
}

const resp = (): CachedResponse => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"ok":true}'),
  streamed: false,
  model: 'claude',
  inputTokens: 1,
  outputTokens: 1,
  createdAtMs: 0, // read-side field; unused by set()
});

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
});

afterAll(async () => {
  await client.close();
});

describe('PostgresExactCache.sweepExpired (real SQL via pglite)', () => {
  it('deletes expired rows and keeps live ones', async () => {
    const cache = new PostgresExactCache(db);
    await cache.set('scopeA:live', resp(), 300); // live
    await cache.set('scopeA:stale', resp(), -300); // already expired

    // get() already hides the expired row, but it is still on disk until swept.
    expect(await cache.get('scopeA:live')).not.toBeNull();
    expect(await cache.get('scopeA:stale')).toBeNull();

    const removed = await cache.sweepExpired();
    expect(removed).toBe(1); // the stale row was reclaimed

    // A second sweep is a no-op; the live row survives.
    expect(await cache.sweepExpired()).toBe(0);
    expect(await cache.get('scopeA:live')).not.toBeNull();
  });
});
