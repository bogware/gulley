import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limiter';
import type { RateLimit, RateLimitStore } from './types';

const rule: RateLimit = { id: 'rpm', limit: 10, windowSeconds: 60, unit: 'requests' };

const brokenStore: RateLimitStore = {
  reserve: async () => {
    throw new Error('redis down');
  },
  commit: async () => {
    throw new Error('redis down');
  },
};

describe('RateLimiter — dependency failures degrade per policy, never escape', () => {
  it('a failing RULE RESOLVER (Postgres) degrades exactly like a failing store', async () => {
    const seen: string[] = [];
    const open = new RateLimiter({
      store: brokenStore,
      resolve: async () => {
        throw new Error('pg down');
      },
      onError: (_e, stage) => seen.push(stage),
    });
    const r = await open.check('ws', 'req');
    expect(r.outcome.allowed).toBe(true);
    expect(r.outcome.degraded).toBe(true);
    expect(seen).toEqual(['resolve']);

    const closed = new RateLimiter({
      store: brokenStore,
      resolve: async () => {
        throw new Error('pg down');
      },
      failOpen: false,
    });
    const c = await closed.check('ws', 'req');
    expect(c.outcome.allowed).toBe(false);
    expect(c.outcome.retryAfterSeconds).toBe(1);
  });

  it('reports the failing stage for store faults on reserve and commit', async () => {
    const seen: string[] = [];
    const limiter = new RateLimiter({
      store: brokenStore,
      resolve: async () => [rule, { ...rule, id: 'tpm', unit: 'tokens' }],
      onError: (_e, stage) => seen.push(stage),
    });
    const r = await limiter.check('ws', 'req');
    expect(r.outcome.degraded).toBe(true);
    expect(r.rules).toHaveLength(2);
    await limiter.commit('ws', r.rules, 'req', 50);
    expect(seen).toEqual(['reserve', 'commit']);
  });
});
