import { RedisBudgetStore } from '@gulley/budget';
import { createRedisClient } from '@gulley/storage';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Opt-in integration test against a REAL Redis (the Lua reserve/commit scripts cannot
 * run against an in-memory fake). Set GULLEY_TEST_REDIS_URL, e.g.
 *   docker run -d --rm -p 6399:6379 redis:7-alpine
 *   GULLEY_TEST_REDIS_URL=redis://localhost:6399 pnpm --filter @gulley/gateway test budget-redis
 * Skipped (not failed) when the variable is absent, so the offline gate stays green.
 */
const url = process.env['GULLEY_TEST_REDIS_URL'];

describe.skipIf(!url)('RedisBudgetStore against a live Redis', () => {
  const redis = createRedisClient(url ?? 'redis://localhost:6379', { role: 'counters' });
  const ws = `ws_live_${Date.now()}`;
  const prefix = `budget:{${ws}}:`;

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('commit is idempotent and its dedupe footprint is bounded and self-expiring', async () => {
    const lifetimeMs = 60_000;
    const store = new RedisBudgetStore(
      redis,
      async () => ({ capMicroUsd: 1_000_000_000, periodSeconds: 3600 }),
      lifetimeMs,
    );
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const r = await store.reserve(ws, `r${i}`, 10);
      expect(r?.allowed).toBe(true);
      await store.commit(ws, `r${i}`, 7);
    }
    expect(Number(await redis.get(`${prefix}committed`))).toBe(7 * n);

    // A resent commit (lost reply + ioredis retry) must not double-count.
    await store.commit(ws, 'r1', 7);
    await store.commit(ws, 'r1', 7);
    expect(Number(await redis.get(`${prefix}committed`))).toBe(7 * n);

    // No shared, ever-growing set; one self-expiring key per request instead.
    expect(await redis.exists(`${prefix}committed_ids`)).toBe(0);
    const cids = await redis.keys(`${prefix}cid:*`);
    expect(cids.length).toBe(n);
    const ttl = await redis.ttl(cids[0] ?? '');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(lifetimeMs / 1000);

    // Every reservation field was released by its commit (only __total may remain).
    const reserved = await redis.hgetall(`${prefix}reserved`);
    const fields = Object.keys(reserved).filter((k) => k !== '__total');
    expect(fields).toEqual([]);
    expect(Number(reserved['__total'] ?? '0')).toBe(0);
  }, 120_000);
});
