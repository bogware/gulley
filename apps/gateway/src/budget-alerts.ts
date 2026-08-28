/** A budget crossing a soft threshold — emitted once per threshold per period so an
 *  operator gets a heads-up (webhook/metric) BEFORE the hard 402, without spam. */
export interface BudgetAlertEvent {
  workspaceId: string;
  /** The crossed threshold as a fraction (e.g. 0.8, 0.9). */
  threshold: number;
  usedMicroUsd: number;
  capMicroUsd: number;
  /** used / cap. */
  utilization: number;
}

export type BudgetAlertSink = (event: BudgetAlertEvent) => void;

/**
 * Fires a soft-threshold alert as a workspace's budget utilization crosses each
 * configured level (80% / 90% …), exactly once per level per budget period. State
 * is per-workspace, reset when utilization falls back below the lowest threshold (a
 * new period / a raised cap), so it never spams. Pure + synchronous: the injected
 * {@link BudgetAlertSink} does the actual I/O (webhook POST + metric), and is called
 * fire-and-forget off the hot path so a slow/failing alert never affects a request.
 */
export class BudgetAlerter {
  private readonly thresholds: number[];
  private readonly highestAlerted = new Map<string, number>();

  constructor(
    thresholds: number[],
    private readonly emit: BudgetAlertSink,
  ) {
    this.thresholds = [...thresholds].filter((t) => t > 0 && t <= 1).sort((a, b) => a - b);
  }

  check(workspaceId: string, usedMicroUsd: number, capMicroUsd: number): void {
    if (this.thresholds.length === 0 || capMicroUsd <= 0) return;
    const utilization = usedMicroUsd / capMicroUsd;
    const lowest = this.thresholds[0] as number;
    if (utilization < lowest) {
      this.highestAlerted.delete(workspaceId); // dropped below the floor → period reset
      return;
    }
    const last = this.highestAlerted.get(workspaceId) ?? 0;
    for (const threshold of this.thresholds) {
      if (utilization >= threshold && threshold > last) {
        this.emit({ workspaceId, threshold, usedMicroUsd, capMicroUsd, utilization });
        this.highestAlerted.set(workspaceId, threshold);
      }
    }
  }
}
