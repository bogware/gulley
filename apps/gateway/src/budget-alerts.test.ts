import type { AlertEvent } from '@gulley/alerts';
import { describe, expect, it } from 'vitest';
import { type BudgetAlertEvent, BudgetAlerter } from './budget-alerts';

describe('BudgetAlerter', () => {
  const collect = (): { events: BudgetAlertEvent[]; sink: (e: BudgetAlertEvent) => void } => {
    const events: BudgetAlertEvent[] = [];
    return { events, sink: (e) => events.push(e) };
  };

  it('fires each threshold once as utilization climbs, then not again', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.8, 0.9], sink);
    a.check('ws', 700, 1000); // 70% — below the floor, nothing
    expect(events).toHaveLength(0);
    a.check('ws', 850, 1000); // 85% — crosses 0.8
    a.check('ws', 880, 1000); // still 88% — no re-alert for 0.8
    expect(events.map((e) => e.threshold)).toEqual([0.8]);
    a.check('ws', 950, 1000); // 95% — crosses 0.9
    expect(events.map((e) => e.threshold)).toEqual([0.8, 0.9]);
    a.check('ws', 990, 1000); // no more thresholds
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      scope: 'ws',
      scopeKind: 'workspace',
      entity: 'ws',
      workspaceId: 'ws',
      utilization: 0.85,
    });
  });

  it('resets when utilization drops below the floor (new period / raised cap)', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.8, 0.9], sink);
    a.check('ws', 950, 1000); // crosses both
    expect(events).toHaveLength(2);
    a.check('ws', 100, 1000); // back to 10% — reset
    a.check('ws', 850, 1000); // crosses 0.8 again
    expect(events.map((e) => e.threshold)).toEqual([0.8, 0.9, 0.8]);
  });

  it('is a no-op with no thresholds or a zero cap', () => {
    const { events, sink } = collect();
    new BudgetAlerter([], sink).check('ws', 999, 1000);
    new BudgetAlerter([0.8], sink).check('ws', 999, 0);
    expect(events).toHaveLength(0);
  });

  it('tracks scopes independently and describes each one', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.9], sink);
    a.check('a', 950, 1000);
    a.check('key:a:vk_9', 950, 1000);
    a.check('org:o1', 950, 1000);
    expect(events.map((e) => [e.scopeKind, e.entity, e.workspaceId])).toEqual([
      ['workspace', 'a', 'a'],
      ['key', 'vk_9', 'a'],
      ['org', 'o1', undefined],
    ]);
  });

  it('re-arms when the calendar window rolls, and reports the window on the event', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.5], sink);
    const day1 = { period: { kind: 'daily' as const }, resetsAtMs: Date.UTC(2026, 9, 12) };
    const day2 = { period: { kind: 'daily' as const }, resetsAtMs: Date.UTC(2026, 9, 13) };
    a.check('ws', 600, 1000, day1);
    a.check('ws', 700, 1000, day1); // same window — no re-alert
    expect(events).toHaveLength(1);
    expect(events[0]?.window).toEqual({ period: 'daily', resetsAt: '2026-10-12T00:00:00.000Z' });
    a.check('ws', 600, 1000, day2); // new window, same utilization band → alerts again
    expect(events).toHaveLength(2);
  });

  it('reports the hard rejection once per window even when 1 is not a configured threshold', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.5], sink);
    const day1 = { period: { kind: 'daily' as const }, resetsAtMs: Date.UTC(2026, 9, 12) };
    a.exceeded('user:ws:alice', 990, 1000, day1);
    a.exceeded('user:ws:alice', 990, 1000, day1); // deduped
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      threshold: 1,
      exceeded: true,
      scopeKind: 'user',
      entity: 'alice',
    });
    a.check('user:ws:alice', 990, 1000, day1); // the 0.5 level is below the 1 already reported
    expect(events).toHaveLength(1);
    a.exceeded('user:ws:alice', 990, 1000, { ...day1, resetsAtMs: Date.UTC(2026, 9, 13) });
    expect(events).toHaveLength(2); // next day: a fresh rejection is news again
  });

  it('emits budget.threshold through the injected AlertSink; the hard rejection is left to the pipeline', () => {
    const alerts: AlertEvent[] = [];
    const observed: BudgetAlertEvent[] = [];
    const now = () => new Date('2026-10-11T12:00:00.000Z');
    const a = new BudgetAlerter([0.8, 0.9], {
      onEvent: (e) => observed.push(e),
      sink: { emit: (e) => alerts.push(e) },
      now,
    });
    const day = { period: { kind: 'daily' as const }, resetsAtMs: Date.UTC(2026, 9, 12) };
    a.check('key:ws-1:vk_9', 950, 1000, day);
    expect(observed.map((e) => e.threshold)).toEqual([0.8, 0.9]);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toEqual({
      kind: 'budget.threshold',
      at: '2026-10-11T12:00:00.000Z',
      severity: 'warning',
      scope: 'key:ws-1:vk_9',
      scopeKind: 'key',
      entity: 'vk_9',
      window: 'daily',
      workspaceId: 'ws-1',
      threshold: 0.8,
      usedMicroUsd: 950,
      capMicroUsd: 1000,
      utilization: 0.95,
    });
    // A lifetime cap (no window) is labelled as such (0.85: only the 0.8 level).
    a.check('org:o1', 850, 1000);
    expect(alerts[2]).toMatchObject({ scopeKind: 'org', entity: 'o1', window: 'lifetime' });
    expect(alerts[2]).not.toHaveProperty('workspaceId');
    // The 402 is observed locally but not re-announced here: budget.exceeded carries the
    // request id and is emitted by the pipeline.
    a.exceeded('key:ws-1:vk_9', 1001, 1000, day);
    expect(observed).toHaveLength(4);
    expect(alerts).toHaveLength(3);
  });

  it('never lets a throwing observer or sink reach the caller', () => {
    const a = new BudgetAlerter([0.8], {
      onEvent: () => {
        throw new Error('observer boom');
      },
      sink: {
        emit: () => {
          throw new Error('sink boom');
        },
      },
    });
    expect(() => a.check('ws', 900, 1000)).not.toThrow();
    expect(() => a.exceeded('ws', 1001, 1000)).not.toThrow();
  });
});
