import { describe, expect, it } from 'vitest';
import { estimateWorstCaseMicroUsd } from './estimate';
import { InMemoryBudgetStore } from './memory';
import { type EvalRedis, RedisBudgetStore } from './redis';
import type { Budget } from './types';

/** A minimal Redis that interprets the committed-counter EXISTS/GET/SET the HEAL
 *  script performs — enough to exercise RedisBudgetStore.healCommitted's
 *  only-rebuild-a-lost-counter semantics without a live Redis. */
class HealFakeRedis implements EvalRedis {
  constructor(private readonly committed = new Map<string, number>()) {}
  get(key: string): number {
    return this.committed.get(key) ?? 0;
  }
  async eval(_script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    const ledgerSum = Number(args[1]);
    if (this.committed.has(key)) return [0, this.committed.get(key) ?? 0]; // EXISTS==1
    if (ledgerSum > 0) {
      this.committed.set(key, ledgerSum);
      return [1, ledgerSum];
    }
    return [0, 0];
  }
}

describe('RedisBudgetStore.healCommitted', () => {
  const cap = async () => ({ capMicroUsd: 1_000_000, periodSeconds: 3600 });

  it('rebuilds a lost (absent) counter from the ledger sum', async () => {
    const redis = new HealFakeRedis(); // committed absent (as after a flush)
    const store = new RedisBudgetStore(redis, cap);
    const r = await store.healCommitted('ws_1', 750_000, 3600);
    expect(r).toEqual({ healed: true, committedMicroUsd: 750_000 });
    expect(redis.get('budget:{ws_1}:committed')).toBe(750_000);
  });

  it('never overwrites a LIVE counter, even when the sliding ledger sum is higher', async () => {
    // The regression: a live fixed-window counter (600k) whose sliding ledger sum
    // (900k, incl. prior-window spend) is higher must NOT be raised — that would
    // over-enforce a healthy workspace on every restart.
    const redis = new HealFakeRedis(new Map([['budget:{ws_1}:committed', 600_000]]));
    const store = new RedisBudgetStore(redis, cap);
    const r = await store.healCommitted('ws_1', 900_000, 3600);
    expect(r).toEqual({ healed: false, committedMicroUsd: 600_000 });
    expect(redis.get('budget:{ws_1}:committed')).toBe(600_000);
  });
});

describe('estimateWorstCaseMicroUsd', () => {
  it('over-estimates input and prices the full output budget', () => {
    // gpt-4o-mini $0.15/$0.60 per MTok; input est = ceil(300/3)=100 tokens.
    // 100*0.15/1e6 = $0.000015 ; 1000*0.60/1e6 = $0.0006 ; total = $0.000615 => 615 microUsd.
    expect(estimateWorstCaseMicroUsd('openai', 'gpt-4o-mini', 300, 1000)).toBe(615);
  });

  it('reserves a conservative non-zero floor for an unpriced model (no cap bypass)', () => {
    // Unknown pricing must NOT price to 0 (that would let a budget be bypassed by
    // requesting any unpriced model, e.g. an arbitrary Azure deployment name).
    // floor = 100*15/1e6 + 1000*75/1e6 = 0.0765 USD => 76500 microUSD.
    expect(estimateWorstCaseMicroUsd('azure', 'prod-custom-deployment', 300, 1000)).toBe(76500);
  });

  it('prices a catalog-only (unseeded) model via the resolver, matching commit', () => {
    // A model absent from the seed table but priced by the catalog resolver must
    // reserve at the resolver's rate, NOT the unknown-pricing floor — so admission
    // and commit agree. gemini-x @ $3/$15 per MTok; input est = ceil(300/3)=100.
    const resolver = (_p: string, m: string) =>
      m === 'gemini-x' ? { input: 3, output: 15 } : undefined;
    // 100*3/1e6 + 1000*15/1e6 = 0.0003 + 0.015 = 0.0153 USD => 15300 microUsd.
    expect(estimateWorstCaseMicroUsd('gemini', 'gemini-x', 300, 1000, resolver)).toBe(15300);
    // Without the resolver it would spuriously reserve at the Opus-class floor.
    expect(estimateWorstCaseMicroUsd('gemini', 'gemini-x', 300, 1000)).toBe(76500);
  });
});

describe('InMemoryBudgetStore', () => {
  const caps = (): Map<string, Budget> => new Map([['ws', { capMicroUsd: 1000 }]]);

  it('does not enforce a workspace without a budget', async () => {
    const s = new InMemoryBudgetStore(caps());
    expect(await s.reserve('other', 'r1', 500)).toBeNull();
  });

  it('rejects a concurrent burst that would breach the cap (TOCTOU-safe)', async () => {
    const s = new InMemoryBudgetStore(caps());
    const [a, b, c] = await Promise.all([
      s.reserve('ws', 'r1', 600),
      s.reserve('ws', 'r2', 600), // 600 + 600 > 1000
      s.reserve('ws', 'r3', 400),
    ]);
    const allowed = [a, b, c].filter((d) => d?.allowed).length;
    expect(allowed).toBe(2); // 600 + 400 fit; the second 600 is rejected
    expect([a, b, c].some((d) => d?.allowed === false)).toBe(true);
  });

  it('commit refunds the reservation minus actual, freeing headroom', async () => {
    const s = new InMemoryBudgetStore(caps());
    expect((await s.reserve('ws', 'r1', 900))?.allowed).toBe(true);
    // Only 100 headroom now → a 200 reserve is rejected.
    expect((await s.reserve('ws', 'r2', 200))?.allowed).toBe(false);

    // Actual spend was only 100 → refund 800.
    await s.commit('ws', 'r1', 100);
    expect(s.committed('ws')).toBe(100);
    expect((await s.reserve('ws', 'r3', 800))?.allowed).toBe(true);
  });

  it('accepts a resolver so dynamically-keyed scopes enforce without a seed map', async () => {
    // Regression: on the counter-less path an `attr:<key>:<value>` scope (value
    // known only at request time) must enforce exactly as it does against Redis.
    // A resolver keyed by the attr key — mirroring the gateway's cap composition —
    // caps EVERY distinct value under the same budget, so the store must consult
    // the resolver rather than a static map.
    const s = new InMemoryBudgetStore((scope) =>
      scope.startsWith('attr:session:') ? { capMicroUsd: 1000, periodSeconds: 86_400 } : null,
    );
    // Two different session values both resolve to the cap and both enforce it.
    expect((await s.reserve('attr:session:s1', 'r1', 600))?.allowed).toBe(true);
    expect((await s.reserve('attr:session:s1', 'r2', 600))?.allowed).toBe(false); // 600+600>1000
    expect((await s.reserve('attr:session:s2', 'r3', 900))?.allowed).toBe(true); // independent key
    // A scope the resolver doesn't recognize is unenforced (null), as before.
    expect(await s.reserve('ws:unknown', 'r4', 10)).toBeNull();
  });
});
