import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db';
import * as schema from './schema';
import {
  InMemorySessionBlockStore,
  loadActiveSessionBlocks,
  PostgresSessionBlockStore,
  SessionBlockSnapshot,
  type SessionBlockStore,
} from './session-block-store';

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

const WS = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await applyMigrations(client);
});

afterAll(async () => {
  await client.close();
});

/** The same contract tests against the Postgres and the in-memory store. */
function storeContract(name: string, make: (now: () => Date) => SessionBlockStore): void {
  describe(name, () => {
    let clock = Date.UTC(2026, 9, 11, 10, 0, 0);
    const now = (): Date => new Date(clock);

    it('blocks, lists, answers isBlocked and unblocks', async () => {
      const store = make(now);
      const rec = await store.block({
        workspaceId: WS,
        session: 'sess-a',
        reason: 'loop',
        source: 'manual',
        createdBy: 'admin@example',
      });
      expect(rec).toMatchObject({
        workspaceId: WS,
        session: 'sess-a',
        reason: 'loop',
        source: 'manual',
        createdBy: 'admin@example',
        expiresAt: null,
      });
      expect(await store.isBlocked(WS, 'sess-a')).toBe(true);
      expect(await store.isBlocked(OTHER, 'sess-a')).toBe(false); // per workspace
      expect(await store.isBlocked(WS, 'sess-b')).toBe(false);
      expect((await store.list({ workspaceIds: [WS] })).map((r) => r.session)).toEqual(['sess-a']);
      expect(await store.list({ workspaceIds: [] })).toEqual([]); // empty scope = nothing
      expect(await store.unblock(WS, 'sess-a')).toBe(true);
      expect(await store.unblock(WS, 'sess-a')).toBe(false);
      expect(await store.isBlocked(WS, 'sess-a')).toBe(false);
    });

    it('expires a TTL block on read, re-block refreshes it, and the sweep reclaims it', async () => {
      const store = make(now);
      await store.block({
        workspaceId: WS,
        session: 'sess-ttl',
        reason: 'runaway: $42 vs baseline $4',
        source: 'runaway',
        createdBy: 'runaway-detector',
        ttlSeconds: 600,
      });
      expect(await store.isBlocked(WS, 'sess-ttl')).toBe(true);
      clock += 601_000;
      expect(await store.isBlocked(WS, 'sess-ttl')).toBe(false);
      expect(await store.list({ workspaceIds: [WS] })).toEqual([]);
      expect((await store.list({ workspaceIds: [WS], includeExpired: true })).length).toBe(1);
      // Re-block (upsert) extends it from now.
      const again = await store.block({
        workspaceId: WS,
        session: 'sess-ttl',
        reason: 'again',
        source: 'manual',
        createdBy: 'ops',
        ttlSeconds: 60,
      });
      expect(again.source).toBe('manual');
      expect(again.expiresAt?.getTime()).toBe(clock + 60_000);
      expect(await store.isBlocked(WS, 'sess-ttl')).toBe(true);
      clock += 61_000;
      expect(await store.sweepExpired(now())).toBe(1);
      expect(await store.list({ workspaceIds: [WS], includeExpired: true })).toEqual([]);
    });
  });
}

storeContract('PostgresSessionBlockStore', (now) => new PostgresSessionBlockStore(db, now));
storeContract('InMemorySessionBlockStore', (now) => new InMemorySessionBlockStore(now));

describe('loadActiveSessionBlocks', () => {
  it('returns only non-expired blocks across every workspace', async () => {
    const store = new PostgresSessionBlockStore(db);
    await store.block({
      workspaceId: WS,
      session: 'live',
      reason: 'r',
      source: 'manual',
      createdBy: 'x',
    });
    await store.block({
      workspaceId: OTHER,
      session: 'live-ttl',
      reason: 'r',
      source: 'runaway',
      createdBy: 'x',
      ttlSeconds: 3600,
    });
    await store.block({
      workspaceId: WS,
      session: 'dead',
      reason: 'r',
      source: 'runaway',
      createdBy: 'x',
      ttlSeconds: 1,
    });
    const future = new Date(Date.now() + 10_000);
    const active = await loadActiveSessionBlocks(db, future);
    expect(active.map((a) => `${a.workspaceId}:${a.session}`).sort()).toEqual([
      `${WS}:live`,
      `${OTHER}:live-ttl`,
    ]);
    expect(active.find((a) => a.session === 'live')?.expiresAt).toBeNull();
    expect(active.find((a) => a.session === 'live-ttl')?.expiresAt).toBeInstanceOf(Date);
  });
});

describe('SessionBlockSnapshot', () => {
  it('awaits the first load, reads synchronously, honours local expiry, and is stale-on-error', async () => {
    let clock = 1_000_000;
    let fail = false;
    let loads = 0;
    const loader = async () => {
      loads++;
      if (fail) throw new Error('db down');
      return [
        { workspaceId: WS, session: 'forever', expiresAt: null },
        { workspaceId: WS, session: 'short', expiresAt: new Date(clock + 5_000) },
        { workspaceId: WS, session: 'already', expiresAt: new Date(clock - 1) },
      ];
    };
    const snap = new SessionBlockSnapshot(loader, 60_000, () => clock);
    expect(snap.isBlocked(WS, 'forever')).toBe(false); // nothing loaded yet
    await snap.start();
    try {
      expect(loads).toBe(1);
      expect(snap.size).toBe(2); // the already-expired row is dropped on load
      expect(snap.isBlocked(WS, 'forever')).toBe(true);
      expect(snap.isBlocked(WS, 'short')).toBe(true);
      expect(snap.isBlocked(WS, 'already')).toBe(false);
      expect(snap.isBlocked(OTHER, 'forever')).toBe(false);
      clock += 6_000;
      expect(snap.isBlocked(WS, 'short')).toBe(false); // lapsed between refreshes
      expect(snap.isBlocked(WS, 'forever')).toBe(true);
      // A failing refresh keeps the last snapshot and records the error.
      fail = true;
      await snap.refresh();
      expect(snap.isBlocked(WS, 'forever')).toBe(true);
      expect(snap.status.lastError).toBeInstanceOf(Error);
      expect(snap.status.lastRefreshAt).toBe(1_000_000);
      fail = false;
      await snap.refresh();
      expect(snap.status.lastError).toBeUndefined();
      await snap.start(); // idempotent
      expect(loads).toBe(3);
    } finally {
      snap.stop();
    }
  });
});
