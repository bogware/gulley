import { describe, expect, it } from 'vitest';
import { InMemoryBudgetStore } from './memory';
import {
  budgetScope,
  type BudgetSpec,
  normalizeBudget,
  parseBudgetConfig,
  parseBudgetScope,
} from './types';
import {
  parsePeriod,
  periodLabel,
  secondsUntilReset,
  windowEnd,
  windowId,
  windowStart,
} from './window';

const T = Date.UTC(2026, 9, 11, 15, 30, 0); // Sunday 2026-10-11 15:30 UTC

describe('calendar windows', () => {
  it('derives stable UTC window ids and resets at midnight / Monday / the 1st', () => {
    expect(windowId({ kind: 'daily' }, T)).toBe('d:2026-10-11');
    expect(windowId({ kind: 'weekly' }, T)).toBe('w:2026-W41'); // ISO week of 2026-10-11 (Sunday)
    expect(windowId({ kind: 'monthly' }, T)).toBe('m:2026-10');
    expect(new Date(windowStart({ kind: 'daily' }, T)).toISOString()).toBe(
      '2026-10-11T00:00:00.000Z',
    );
    expect(new Date(windowStart({ kind: 'weekly' }, T)).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    ); // Monday
    expect(new Date(windowEnd({ kind: 'weekly' }, T)).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
    expect(new Date(windowEnd({ kind: 'monthly' }, T)).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(secondsUntilReset({ kind: 'daily' }, T)).toBe(8.5 * 3600);
    // Monday 00:00 belongs to the new week; the instant before belongs to the old one.
    const monday = Date.UTC(2026, 9, 12, 0, 0, 0);
    expect(windowId({ kind: 'weekly' }, monday)).toBe('w:2026-W42');
    expect(windowId({ kind: 'weekly' }, monday - 1)).toBe('w:2026-W41');
    // Year boundary: 2026-12-31 is a Thursday → ISO week 53 of 2026.
    expect(windowId({ kind: 'weekly' }, Date.UTC(2026, 11, 31))).toBe('w:2026-W53');
  });

  it('parses the period vocabulary (none/daily/weekly/monthly, {seconds}, "30d", legacy seconds)', () => {
    expect(parsePeriod('daily')).toEqual({ kind: 'daily' });
    expect(parsePeriod('none')).toEqual({ kind: 'none' });
    expect(parsePeriod(3600)).toEqual({ kind: 'fixed', seconds: 3600 });
    expect(parsePeriod('30d')).toEqual({ kind: 'fixed', seconds: 30 * 86_400 });
    expect(parsePeriod({ seconds: 90 })).toEqual({ kind: 'fixed', seconds: 90 });
    expect(parsePeriod({ kind: 'monthly' })).toEqual({ kind: 'monthly' });
    expect(parsePeriod('fortnightly')).toBeUndefined();
    expect(parsePeriod(-1)).toBeUndefined();
    expect(periodLabel({ kind: 'fixed', seconds: 60 })).toBe('60s window');
  });
});

describe('budget config parsing and scopes', () => {
  it('normalises the legacy shape and validates the windows shape', () => {
    expect(normalizeBudget({ capMicroUsd: 5, periodSeconds: 60 })).toEqual({
      windows: [{ capMicroUsd: 5, period: { kind: 'fixed', seconds: 60 } }],
    });
    expect(parseBudgetConfig({ capMicroUsd: 5 }).spec).toEqual({
      windows: [{ capMicroUsd: 5, period: { kind: 'none' } }],
    });
    expect(
      parseBudgetConfig({
        windows: [
          { capMicroUsd: 10_000_000, period: 'daily' },
          { capMicroUsd: 100_000_000, period: 'monthly' },
        ],
      }).spec?.windows.map((w) => w.period.kind),
    ).toEqual(['daily', 'monthly']);
    expect(parseBudgetConfig({ capMicroUsd: 0 }).problem).toMatch(/positive integer/);
    expect(parseBudgetConfig({ windows: [] }).problem).toMatch(/at least one/);
    expect(parseBudgetConfig({ windows: [{ capMicroUsd: 1, period: 'yearly' }] }).problem).toMatch(
      /period/,
    );
    expect(
      parseBudgetConfig({
        windows: [
          { capMicroUsd: 1, period: 'none' },
          { capMicroUsd: 2, period: '1d' },
        ],
      }).problem,
    ).toMatch(/at most one lifetime or fixed/);
  });

  it('round-trips scope strings', () => {
    expect(budgetScope({ kind: 'workspace', entity: 'ws1' })).toBe('ws1');
    expect(budgetScope({ kind: 'org', entity: 'o1' })).toBe('org:o1');
    expect(budgetScope({ kind: 'key', workspaceId: 'ws1', entity: 'vk_9' })).toBe('key:ws1:vk_9');
    expect(parseBudgetScope('user:ws1:alice@example.com')).toEqual({
      kind: 'user',
      workspaceId: 'ws1',
      entity: 'alice@example.com',
    });
    expect(parseBudgetScope('team:ws1:ml:research')).toEqual({
      kind: 'team',
      workspaceId: 'ws1',
      entity: 'ml:research',
    });
    expect(parseBudgetScope('attr:session:abc')).toEqual({ kind: 'attr', entity: 'session:abc' });
    expect(parseBudgetScope('ws1')).toEqual({ kind: 'workspace', entity: 'ws1' });
  });
});

describe('InMemoryBudgetStore — multi-window calendar caps', () => {
  const spec: BudgetSpec = {
    windows: [
      { capMicroUsd: 1_000, period: { kind: 'daily' } },
      { capMicroUsd: 1_500, period: { kind: 'monthly' } },
    ],
  };

  it('every window must admit; the binding window is reported and the daily one resets at midnight UTC', async () => {
    let now = T;
    const store = new InMemoryBudgetStore(new Map([['ws', spec]]), () => now);
    for (let i = 0; i < 3; i++) {
      const d = await store.reserve('ws', `r${i}`, 300);
      expect(d?.allowed).toBe(true);
      await store.commit('ws', `r${i}`, 300);
    }
    // Day: 900 committed; 300 more breaches the DAILY cap (1000) → rejected, binding = daily.
    const rejected = await store.reserve('ws', 'r3', 300);
    expect(rejected?.allowed).toBe(false);
    expect(rejected?.capMicroUsd).toBe(1_000);
    expect(rejected?.window?.period).toEqual({ kind: 'daily' });
    expect(new Date(rejected?.window?.resetsAtMs ?? 0).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    );
    // Next day: the daily counter is a fresh window; the monthly still carries 900.
    now = Date.UTC(2026, 9, 12, 1, 0, 0);
    const d = await store.reserve('ws', 'r4', 300);
    expect(d?.allowed).toBe(true);
    expect(store.committed('ws', { kind: 'daily' })).toBe(0);
    expect(store.committed('ws', { kind: 'monthly' })).toBe(900);
    await store.commit('ws', 'r4', 300);
    // Month: 1200 committed; a 400 reserve fits the day (300 + 400 ≤ 1000) but breaches
    // the month (1200 + 400 > 1500) — the monthly window is the one that rejects.
    const m = await store.reserve('ws', 'r5', 400);
    expect(m?.allowed).toBe(false);
    expect(m?.window?.period).toEqual({ kind: 'monthly' });
    expect(m?.capMicroUsd).toBe(1_500);
    // Next month: everything resets.
    now = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect((await store.reserve('ws', 'r6', 1_400))?.allowed).toBe(false); // daily cap 1000 still binds
    expect((await store.reserve('ws', 'r7', 900))?.allowed).toBe(true);
  });

  it('a legacy fixed-window cap behaves as before (window from first spend)', async () => {
    let now = T;
    const store = new InMemoryBudgetStore(
      new Map([['ws', { capMicroUsd: 100, periodSeconds: 60 }]]),
      () => now,
    );
    await store.reserve('ws', 'r1', 100);
    await store.commit('ws', 'r1', 100);
    expect((await store.reserve('ws', 'r2', 1))?.allowed).toBe(false);
    now += 61_000;
    expect((await store.reserve('ws', 'r2', 1))?.allowed).toBe(true);
  });

  it('a rollback ($0 commit) never creates a window counter', async () => {
    const store = new InMemoryBudgetStore(new Map([['ws', spec]]), () => T);
    await store.reserve('ws', 'r1', 10);
    await store.commit('ws', 'r1', 0);
    expect(store.committed('ws', { kind: 'daily' })).toBe(0);
    expect(store.committed('ws', { kind: 'monthly' })).toBe(0);
  });
});
