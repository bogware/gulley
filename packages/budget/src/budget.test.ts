import { describe, expect, it } from 'vitest';
import { estimateWorstCaseMicroUsd } from './estimate';
import { InMemoryBudgetStore } from './memory';
import type { Budget } from './types';

describe('estimateWorstCaseMicroUsd', () => {
  it('over-estimates input and prices the full output budget', () => {
    // gpt-4o-mini $0.15/$0.60 per MTok; input est = ceil(300/3)=100 tokens.
    // 100*0.15/1e6 = $0.000015 ; 1000*0.60/1e6 = $0.0006 ; total = $0.000615 => 615 microUsd.
    expect(estimateWorstCaseMicroUsd('openai', 'gpt-4o-mini', 300, 1000)).toBe(615);
  });

  it('returns 0 for an unpriced model (nothing to enforce)', () => {
    expect(estimateWorstCaseMicroUsd('openai', 'unknown-model', 300, 1000)).toBe(0);
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
});
