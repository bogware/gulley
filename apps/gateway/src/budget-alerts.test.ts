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

  it('tracks workspaces independently', () => {
    const { events, sink } = collect();
    const a = new BudgetAlerter([0.9], sink);
    a.check('a', 950, 1000);
    a.check('b', 950, 1000);
    expect(events.map((e) => e.workspaceId)).toEqual(['a', 'b']);
  });
});
