import { type AlertSink, makeAlert } from '@gulley/alerts';
import { type BudgetDecision, type BudgetScopeKind, periodLabel } from '@gulley/budget';
import { describeBudgetScope } from './budget-scopes';

/** A budget crossing a soft threshold — emitted once per threshold per window so an
 *  operator gets a heads-up (webhook/metric/alert channel) BEFORE the hard 402 — or,
 *  with `exceeded`, the hard rejection itself (the 100% level). */
export interface BudgetAlertEvent {
  /** The budget scope string (`<ws>`, `org:<id>`, `key:<ws>:<id>`, `model:<m>`, …). */
  scope: string;
  scopeKind: BudgetScopeKind;
  /** The capped entity (a workspace / org / key / user id, a group, a model, …). */
  entity: string;
  /** The workspace the scope belongs to; absent for an org or model scope. */
  workspaceId?: string;
  /** The crossed threshold as a fraction (0.5, 0.75, 1). */
  threshold: number;
  usedMicroUsd: number;
  capMicroUsd: number;
  /** used / cap. */
  utilization: number;
  /** The binding window; absent for a legacy lifetime cap. */
  window?: { period: string; resetsAt?: string };
  /** True for the hard rejection (a request was 402'd against this scope). */
  exceeded?: boolean;
}

export type BudgetAlertSink = (event: BudgetAlertEvent) => void;

export interface BudgetAlerterOptions {
  /** Local observer (the metric, the legacy bare webhook). */
  onEvent?: BudgetAlertSink;
  /** The alert channels (`ALERT_CHANNELS`): every soft crossing is emitted as a
   *  `budget.threshold` event. The hard rejection is NOT emitted from here — the
   *  pipeline announces `budget.exceeded` itself, with the request id. */
  sink?: AlertSink;
  now?: () => Date;
}

const MAX_TRACKED_SCOPES = 50_000;

/**
 * Fires a soft-threshold alert as a budget scope's utilization crosses each configured
 * level (50% / 75% / …), exactly once per level per window, and the hard-rejection
 * alert (threshold 1) once per window. State is per scope and per window: it resets
 * when the calendar window rolls (`resetsAt` changes) or utilization falls back below
 * the lowest threshold (a fixed window rolled / a raised cap), so it never spams. Pure
 * + synchronous: the injected {@link BudgetAlertSink} observer and the {@link AlertSink}
 * channels do the actual I/O, called fire-and-forget off the hot path, and neither can
 * throw into a request.
 */
export class BudgetAlerter {
  private readonly thresholds: number[];
  private readonly state = new Map<string, { window: string; highest: number }>();
  private readonly onEvent: BudgetAlertSink | undefined;
  private readonly sink: AlertSink | undefined;
  private readonly now: () => Date;

  constructor(thresholds: number[], emit: BudgetAlertSink | BudgetAlerterOptions = {}) {
    this.thresholds = [...thresholds].filter((t) => t > 0 && t <= 1).sort((a, b) => a - b);
    const opts: BudgetAlerterOptions = typeof emit === 'function' ? { onEvent: emit } : emit;
    this.onEvent = opts.onEvent;
    this.sink = opts.sink;
    this.now = opts.now ?? (() => new Date());
  }

  check(
    scope: string,
    usedMicroUsd: number,
    capMicroUsd: number,
    window?: BudgetDecision['window'],
  ): void {
    if (this.thresholds.length === 0 || capMicroUsd <= 0) return;
    const utilization = usedMicroUsd / capMicroUsd;
    const lowest = this.thresholds[0] as number;
    if (utilization < lowest) {
      this.state.delete(scope); // dropped below the floor → window rolled / cap raised
      return;
    }
    const last = this.current(scope, window);
    for (const threshold of this.thresholds) {
      if (utilization >= threshold && threshold > last) {
        this.emit(this.event(scope, threshold, usedMicroUsd, capMicroUsd, window));
        this.remember(scope, window, threshold);
      }
    }
  }

  /** The hard rejection: the 100% level, once per scope per window — reported even
   *  when 1 is not a configured threshold, so a 402 is never silent. */
  exceeded(
    scope: string,
    usedMicroUsd: number,
    capMicroUsd: number,
    window?: BudgetDecision['window'],
  ): void {
    if (capMicroUsd <= 0) return;
    if (this.current(scope, window) >= 1) return;
    this.emit({
      ...this.event(scope, 1, usedMicroUsd, capMicroUsd, window),
      exceeded: true,
    });
    this.remember(scope, window, 1);
  }

  private emit(event: BudgetAlertEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* never let an observer affect a request */
    }
    // The hard rejection carries a request id and is announced by the pipeline as
    // `budget.exceeded`; only the soft crossings go to the alert channels from here.
    if (!this.sink || event.exceeded) return;
    try {
      this.sink.emit(
        makeAlert(
          {
            kind: 'budget.threshold',
            scope: event.scope,
            scopeKind: event.scopeKind,
            entity: event.entity,
            window: event.window?.period ?? 'lifetime',
            threshold: event.threshold,
            usedMicroUsd: event.usedMicroUsd,
            capMicroUsd: event.capMicroUsd,
            utilization: event.utilization,
            ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
          },
          this.now,
        ),
      );
    } catch {
      /* the sink contract is never-throw; belt and braces on the hot path */
    }
  }

  private current(scope: string, window: BudgetDecision['window']): number {
    const st = this.state.get(scope);
    if (!st) return 0;
    if (st.window !== windowKey(window)) {
      this.state.delete(scope); // the calendar window rolled
      return 0;
    }
    return st.highest;
  }

  private remember(scope: string, window: BudgetDecision['window'], highest: number): void {
    if (!this.state.has(scope) && this.state.size >= MAX_TRACKED_SCOPES) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
    this.state.set(scope, { window: windowKey(window), highest });
  }

  private event(
    scope: string,
    threshold: number,
    usedMicroUsd: number,
    capMicroUsd: number,
    window: BudgetDecision['window'],
  ): BudgetAlertEvent {
    const d = describeBudgetScope(scope);
    return {
      scope,
      scopeKind: d.kind,
      entity: d.id,
      ...(d.workspaceId ? { workspaceId: d.workspaceId } : {}),
      threshold,
      usedMicroUsd,
      capMicroUsd,
      utilization: usedMicroUsd / capMicroUsd,
      ...(window
        ? {
            window: {
              period: periodLabel(window.period),
              ...(window.resetsAtMs !== undefined
                ? { resetsAt: new Date(window.resetsAtMs).toISOString() }
                : {}),
            },
          }
        : {}),
    };
  }
}

function windowKey(window: BudgetDecision['window']): string {
  return window?.resetsAtMs !== undefined ? String(window.resetsAtMs) : '';
}
