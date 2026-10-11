import type { AlertEvent } from '@gulley/alerts';
import { InMemoryAuditSink } from '@gulley/pipeline';
import { describe, expect, it } from 'vitest';
import type { KeyView } from './domain';
import { KEY_EXPIRY_SWEEP_ACTOR, KeyExpirySweeper, type KeyExpirySweepResult } from './key-expiry';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;

function key(id: string, expiresAt: string | null, extra: Partial<KeyView> = {}): KeyView {
  return {
    id,
    workspaceId: 'ws-1',
    name: `key-${id}`,
    keyPrefix: `gk_${id}`,
    disabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
    allowedProviders: '*',
    allowedModels: '*',
    groups: [],
    ...extra,
  };
}

function harness(rows: KeyView[], opts: { lock?: 'held' | 'free'; lookbackMs?: number } = {}) {
  const events: AlertEvent[] = [];
  const audit = new InMemoryAuditSink(() => NOW);
  let keys = rows;
  const sweeper = new KeyExpirySweeper({
    keys: {
      listExpiring: async (before) =>
        keys.filter((k) => k.expiresAt !== null && Date.parse(k.expiresAt) <= before.getTime()),
    },
    audit,
    alerts: { emit: (e) => events.push(e) },
    orgIdOf: () => 'org-1',
    withinDays: 7,
    expiredLookbackMs: opts.lookbackMs,
    now: () => NOW,
    ...(opts.lock
      ? {
          lock: async (fn: () => Promise<KeyExpirySweepResult>) =>
            opts.lock === 'held' ? undefined : fn(),
        }
      : {}),
  });
  return { sweeper, events, audit, setKeys: (r: KeyView[]) => (keys = r) };
}

describe('KeyExpirySweeper', () => {
  it('announces keys inside the notice window once, with an audit row each', async () => {
    const soon = new Date(NOW.getTime() + 3.2 * DAY).toISOString();
    const far = new Date(NOW.getTime() + 30 * DAY).toISOString();
    const h = harness([key('a', soon), key('b', far), key('c', null)]);
    const r1 = await h.sweeper.sweep();
    expect(r1).toEqual({ scanned: 1, expiring: 1, expired: 0, skipped: false });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'key.expiring',
      severity: 'warning',
      keyId: 'a',
      displayName: 'key-a',
      workspaceId: 'ws-1',
      expiresAt: soon,
      daysLeft: 4,
      at: NOW.toISOString(),
    });
    expect(h.audit.rows.map((x) => [x.action, x.target, x.actor, x.orgId])).toEqual([
      ['key.expiring_soon', 'a', KEY_EXPIRY_SWEEP_ACTOR, 'org-1'],
    ]);
    // A second tick is silent for the same key.
    const r2 = await h.sweeper.sweep();
    expect(r2).toEqual({ scanned: 1, expiring: 0, expired: 0, skipped: false });
    expect(h.events).toHaveLength(1);
  });

  it('announces key.expired once a key lapses (after an earlier expiring notice)', async () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    const h = harness([key('a', soon)]);
    await h.sweeper.sweep();
    // Time passes: same key, now in the past (rows come back from the same query).
    const lapsed = new Date(NOW.getTime() - 60_000).toISOString();
    h.setKeys([key('a', lapsed)]);
    const r = await h.sweeper.sweep();
    expect(r).toMatchObject({ expiring: 0, expired: 1 });
    expect(h.events.map((e) => e.kind)).toEqual(['key.expiring', 'key.expired']);
    expect(h.audit.rows.map((x) => x.action)).toEqual(['key.expiring_soon', 'key.expired']);
    await h.sweeper.sweep();
    expect(h.events).toHaveLength(2);
  });

  it('ignores keys that expired before the lookback (restart replay is bounded)', async () => {
    const longGone = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const recent = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const h = harness([key('old', longGone), key('new', recent)], { lookbackMs: 3_600_000 });
    const r = await h.sweeper.sweep();
    expect(r).toMatchObject({ scanned: 2, expired: 1 });
    expect(h.events.map((e) => (e as { keyId: string }).keyId)).toEqual(['new']);
  });

  it('re-announces when a key gets a new expiry, and forgets keys that leave the window', async () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    const h = harness([key('a', soon)]);
    await h.sweeper.sweep();
    const later = new Date(NOW.getTime() + 2 * DAY).toISOString();
    h.setKeys([key('a', later)]);
    await h.sweeper.sweep();
    expect(h.events.map((e) => (e as { expiresAt: string }).expiresAt)).toEqual([soon, later]);
    h.setKeys([]); // disabled / deleted / moved out of the window
    await h.sweeper.sweep();
    h.setKeys([key('a', later)]); // back in: announced again (the set was pruned)
    await h.sweeper.sweep();
    expect(h.events).toHaveLength(3);
  });

  it('skips the tick when another replica holds the lock, and runs when it is free', async () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    const held = harness([key('a', soon)], { lock: 'held' });
    expect(await held.sweeper.sweep()).toEqual({
      scanned: 0,
      expiring: 0,
      expired: 0,
      skipped: true,
    });
    expect(held.events).toHaveLength(0);
    const free = harness([key('a', soon)], { lock: 'free' });
    expect(await free.sweeper.sweep()).toMatchObject({ expiring: 1, skipped: false });
  });

  it('does not mark a key announced when the audit row fails (retried next tick)', async () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    const events: AlertEvent[] = [];
    let fail = true;
    const sweeper = new KeyExpirySweeper({
      keys: { listExpiring: async () => [key('a', soon)] },
      audit: {
        append: async () => {
          if (fail) throw new Error('audit down');
          return { seq: 1, prevHash: null, rowHash: 'h', createdAt: NOW, actor: 'x', action: 'y' };
        },
      },
      alerts: { emit: (e) => events.push(e) },
      orgIdOf: () => null,
      withinDays: 7,
      now: () => NOW,
    });
    await expect(sweeper.sweep()).rejects.toThrow(/audit down/);
    expect(events).toHaveLength(0);
    fail = false;
    expect(await sweeper.sweep()).toMatchObject({ expiring: 1 });
    expect(events).toHaveLength(1);
  });
});
