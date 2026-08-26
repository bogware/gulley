import { describe, expect, it } from 'vitest';
import { rateLimitHeaders } from './headers';
import { RateLimiter } from './limiter';
import { InMemoryRateLimitStore } from './memory';
import type { RateLimit, RateLimitStore } from './types';
import { windowFor } from './util';

const rpm = (limit: number): RateLimit => ({
  id: 'rpm',
  limit,
  windowSeconds: 60,
  unit: 'requests',
});
const tpm = (limit: number): RateLimit => ({ id: 'tpm', limit, windowSeconds: 60, unit: 'tokens' });

describe('windowFor', () => {
  it('aligns to epoch-based fixed windows', () => {
    expect(windowFor(1_700_000_045_000, 60)).toEqual({
      start: 1_700_000_040_000,
      resetMs: 1_700_000_100_000,
    });
  });
});

describe('InMemoryRateLimitStore — requests', () => {
  it('admits up to the limit then rejects, with headers', async () => {
    const store = new InMemoryRateLimitStore(() => 1_700_000_000_000);
    const rules = [rpm(2)];

    const a = await store.reserve('ws1', rules, 'r1');
    expect(a.allowed).toBe(true);
    expect(a.limiting?.remaining).toBe(1);

    const b = await store.reserve('ws1', rules, 'r2');
    expect(b.allowed).toBe(true);
    expect(b.limiting?.remaining).toBe(0);

    const c = await store.reserve('ws1', rules, 'r3');
    expect(c.allowed).toBe(false);
    const h = rateLimitHeaders(c);
    expect(h['x-ratelimit-limit']).toBe('2');
    expect(h['x-ratelimit-remaining']).toBe('0');
    expect(Number(h['retry-after'])).toBeGreaterThan(0);
  });

  it('resets after the window elapses', async () => {
    let t = 1_700_000_000_000;
    const store = new InMemoryRateLimitStore(() => t);
    const rules = [rpm(1)];
    expect((await store.reserve('ws', rules, 'a')).allowed).toBe(true);
    expect((await store.reserve('ws', rules, 'b')).allowed).toBe(false);
    t += 60_000; // next window
    expect((await store.reserve('ws', rules, 'c')).allowed).toBe(true);
  });

  it('does not consume request budget when another rule rejects (all-or-nothing)', async () => {
    const store = new InMemoryRateLimitStore(() => 1_700_000_000_000);
    // token window already exhausted → the request rule must not be charged.
    const rules = [rpm(5), tpm(10)];
    await store.commit('ws', rules, 'seed', 10); // fill the token window
    const d = await store.reserve('ws', rules, 'r1');
    expect(d.allowed).toBe(false);
    // The request rule's counter stayed at 0 within the same window — not charged.
    expect(d.decisions.find((x) => x.rule.id === 'rpm')?.used).toBe(0);
  });
});

describe('InMemoryRateLimitStore — tokens (true-up)', () => {
  it('admits while under the token cap, then rejects once metered over', async () => {
    const store = new InMemoryRateLimitStore(() => 1_700_000_000_000);
    const rules = [tpm(100)];

    const first = await store.reserve('ws', rules, 'r1');
    expect(first.allowed).toBe(true); // window empty
    await store.commit('ws', rules, 'r1', 120); // metered 120 tokens (overshoot allowed)

    const second = await store.reserve('ws', rules, 'r2');
    expect(second.allowed).toBe(false); // window now exhausted
    expect(second.limiting?.used).toBe(120);
  });
});

describe('most-constrained header selection', () => {
  it('reports the rule with the least headroom', async () => {
    const store = new InMemoryRateLimitStore(() => 1_700_000_000_000);
    const rules = [rpm(1000), tpm(50)];
    await store.commit('ws', rules, 'seed', 45); // 5 tokens left, ~999 requests left
    const o = await store.reserve('ws', rules, 'r1');
    expect(o.limiting?.rule.id).toBe('tpm');
    expect(o.limiting?.remaining).toBe(5);
  });
});

describe('RateLimiter fail modes', () => {
  const throwing: RateLimitStore = {
    reserve: () => Promise.reject(new Error('redis down')),
    commit: () => Promise.reject(new Error('redis down')),
  };

  it('fails open by default (admits, marks degraded)', async () => {
    const rl = new RateLimiter({ store: throwing, resolve: () => [rpm(1)] });
    const { outcome } = await rl.check('ws', 'r1');
    expect(outcome.allowed).toBe(true);
    expect(outcome.degraded).toBe(true);
  });

  it('fails closed when configured', async () => {
    const rl = new RateLimiter({ store: throwing, resolve: () => [rpm(1)], failOpen: false });
    const { outcome } = await rl.check('ws', 'r1');
    expect(outcome.allowed).toBe(false);
    expect(outcome.degraded).toBe(true);
  });

  it('skips limiting entirely when no rules resolve', async () => {
    const rl = new RateLimiter({ store: new InMemoryRateLimitStore(), resolve: () => [] });
    const { outcome, rules } = await rl.check('ws', 'r1');
    expect(outcome.allowed).toBe(true);
    expect(rules).toHaveLength(0);
  });
});
