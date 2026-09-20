import { describe, expect, it } from 'vitest';
import { InMemoryBudgetStore } from './memory';
import type { Budget } from './types';

describe('InMemoryBudgetStore — periodic caps roll over', () => {
  it('resets committed spend once periodSeconds have elapsed since the first spend', async () => {
    let t = 1_000_000;
    const store = new InMemoryBudgetStore(
      () => ({ capMicroUsd: 100, periodSeconds: 60 }),
      () => t,
    );
    // Spend up to the cap in the first window.
    expect((await store.reserve('ws', 'r1', 100))?.allowed).toBe(true);
    await store.commit('ws', 'r1', 100);
    expect((await store.reserve('ws', 'r2', 1))?.allowed).toBe(false);
    // Still inside the window: still capped.
    t += 30_000;
    expect((await store.reserve('ws', 'r3', 1))?.allowed).toBe(false);
    // Window elapsed: a fresh window starts with the next spend.
    t += 31_000;
    const d = await store.reserve('ws', 'r4', 50);
    expect(d?.allowed).toBe(true);
    expect(d?.usedMicroUsd).toBe(50);
    expect(store.committed('ws')).toBe(0);
  });

  it('a lifetime cap (no periodSeconds) never rolls over', async () => {
    let t = 0;
    const store = new InMemoryBudgetStore(
      () => ({ capMicroUsd: 10 }),
      () => t,
    );
    await store.reserve('ws', 'r1', 10);
    await store.commit('ws', 'r1', 10);
    t += 10 * 24 * 3600 * 1000;
    expect((await store.reserve('ws', 'r2', 1))?.allowed).toBe(false);
  });

  it('a $0 commit does not start a window', async () => {
    let t = 0;
    const store = new InMemoryBudgetStore(
      () => ({ capMicroUsd: 10, periodSeconds: 60 }),
      () => t,
    );
    await store.reserve('ws', 'r1', 5);
    await store.commit('ws', 'r1', 0); // rollback
    t += 10_000;
    await store.reserve('ws', 'r2', 10);
    await store.commit('ws', 'r2', 10); // window starts HERE
    t += 55_000; // 65s after r1's rollback, 55s after the real spend
    expect((await store.reserve('ws', 'r3', 1))?.allowed).toBe(false);
  });

  it('prunes idle scopes so client-controlled attr scopes cannot grow the map forever', async () => {
    let t = 1_000_000; // a window starts at the first spend; epoch 0 is the "no spend" sentinel
    // Attribution caps carry a forced 24 h window: once it has lapsed, an idle scope
    // holds no live spend and is released.
    const store = new InMemoryBudgetStore(
      () => ({ capMicroUsd: 1_000, periodSeconds: 24 * 3600 }),
      () => t,
    );
    for (let i = 0; i < 1_500; i++) {
      await store.reserve(`attr:session:${i}`, `r${i}`, 1);
      await store.commit(`attr:session:${i}`, `r${i}`, 1);
    }
    expect(store.size).toBe(1_500);
    t += 25 * 3600 * 1000; // > 24h idle AND past the 24 h window
    for (let i = 0; i < 1_000; i++) await store.reserve('ws-live', `x${i}`, 0);
    expect(store.size).toBeLessThan(10);
  });

  it('never prunes an idle scope that still holds live committed spend (lifetime / long-window caps)', async () => {
    let t = 1_000_000;
    const caps = new Map<string, Budget>([
      ['ws-lifetime', { capMicroUsd: 1_000 }], // lifetime cap: spend never lapses
      ['ws-weekly', { capMicroUsd: 1_000, periodSeconds: 7 * 24 * 3600 }],
      ['ws-daily', { capMicroUsd: 1_000, periodSeconds: 24 * 3600 }],
      ['ws-live', { capMicroUsd: 1_000 }], // the scope whose traffic triggers the prune
    ]);
    const store = new InMemoryBudgetStore(caps, () => t);
    for (const ws of ['ws-lifetime', 'ws-weekly', 'ws-daily']) {
      await store.reserve(ws, 'r1', 900);
      await store.commit(ws, 'r1', 900);
    }
    t += 25 * 3600 * 1000; // > 24h idle: the daily window lapsed, the others did not
    for (let i = 0; i < 1_000; i++) await store.reserve('ws-live', `x${i}`, 0); // trigger a prune
    expect(store.committed('ws-lifetime')).toBe(900);
    expect(store.committed('ws-weekly')).toBe(900);
    expect(store.committed('ws-daily')).toBe(0);
    // The surviving spend still ENFORCES: the lifetime cap has only 100 of headroom left.
    expect((await store.reserve('ws-lifetime', 'r2', 200))?.allowed).toBe(false);
    expect((await store.reserve('ws-weekly', 'r2', 200))?.allowed).toBe(false);
    expect((await store.reserve('ws-daily', 'r2', 200))?.allowed).toBe(true);
  });
});
