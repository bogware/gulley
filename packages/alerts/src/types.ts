/**
 * Operational alert events. Both planes emit these through an {@link AlertSink}; the
 * dispatcher fans them out to Slack / Teams / PagerDuty / email / signed webhooks.
 *
 * The union is the contract other slices code against: the `kind` strings and the
 * per-kind fields are stable wire shapes (they are what a webhook consumer sees), so
 * extend by ADDING kinds/fields, never by renaming.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

/** Which budget dimension a budget event is about. Mirrors the budget scope families
 *  (workspace cap, per-model cap, per-attribution cap, …). */
export type BudgetScopeKind =
  'workspace' | 'org' | 'key' | 'user' | 'team' | 'project' | 'model' | 'attr';

interface AlertBase {
  /** ISO-8601 timestamp of the event (set by the emitter). */
  at: string;
  /** Set by the emitter; {@link defaultSeverity} gives the per-kind default. */
  severity: AlertSeverity;
}

/** A budget crossed a soft threshold (80 % / 90 % …) — the heads-up before the 402. */
export interface BudgetThresholdAlert extends AlertBase {
  kind: 'budget.threshold';
  /** The budget store scope key (e.g. the workspace id, `model:<id>`, `attr:<k>=<v>`). */
  scope: string;
  scopeKind: BudgetScopeKind;
  /** Human-readable identity of the budgeted entity (workspace id, model id, tag). */
  entity: string;
  /** The budget period / window label (e.g. `monthly`, `period`, `1h`). */
  window: string;
  /** The crossed threshold as a fraction (0.8, 0.9 …). */
  threshold: number;
  usedMicroUsd: number;
  capMicroUsd: number;
  /** used / cap. */
  utilization: number;
  workspaceId?: string;
  orgId?: string;
}

/** A request was refused (402) because the budget is exhausted. */
export interface BudgetExceededAlert extends AlertBase {
  kind: 'budget.exceeded';
  scope: string;
  scopeKind: BudgetScopeKind;
  entity: string;
  window: string;
  usedMicroUsd: number;
  capMicroUsd: number;
  workspaceId?: string;
  orgId?: string;
  requestId: string;
}

/** A virtual key expires within the configured notice window. */
export interface KeyExpiringAlert extends AlertBase {
  kind: 'key.expiring';
  keyId: string;
  displayName: string;
  workspaceId: string;
  expiresAt: string;
  daysLeft: number;
}

/** A virtual key passed its expiry (the gateway now refuses it). */
export interface KeyExpiredAlert extends AlertBase {
  kind: 'key.expired';
  keyId: string;
  displayName: string;
  workspaceId: string;
  expiresAt: string;
}

/** The circuit breaker ejected an upstream target. */
export interface BreakerOpenAlert extends AlertBase {
  kind: 'breaker.open';
  target: string;
  provider: string;
}

/** The circuit breaker re-admitted an upstream target. */
export interface BreakerClosedAlert extends AlertBase {
  kind: 'breaker.closed';
  target: string;
  provider: string;
}

/** A guardrail blocked a request or withheld a response. */
export interface GuardrailBlockedAlert extends AlertBase {
  kind: 'guardrail.blocked';
  direction: 'input' | 'output';
  surface: 'messages' | 'count_tokens';
  workspaceId: string;
  principalId: string;
  categories: string[];
  reason?: string;
}

/** A GitOps / console config apply committed a new version. */
export interface ConfigAppliedAlert extends AlertBase {
  kind: 'config.applied';
  version: number;
  contentHash: string;
  actor: string;
  summary?: unknown;
}

/** The bootstrap token was exchanged for a time-boxed owner session. */
export interface BreakGlassAlert extends AlertBase {
  kind: 'admin.break_glass';
  actor: string;
  reason: string;
  expiresAt: string;
}

/** An agent session's spend ran away from its baseline / the org's p99. */
export interface SessionRunawayAlert extends AlertBase {
  kind: 'session.runaway';
  session: string;
  workspaceId: string;
  principalId?: string;
  costMicroUsd: number;
  baselineMicroUsd: number;
  orgP99MicroUsd: number;
  action: 'blocked' | 'flagged';
}

export type AlertEvent =
  | BudgetThresholdAlert
  | BudgetExceededAlert
  | KeyExpiringAlert
  | KeyExpiredAlert
  | BreakerOpenAlert
  | BreakerClosedAlert
  | GuardrailBlockedAlert
  | ConfigAppliedAlert
  | BreakGlassAlert
  | SessionRunawayAlert;

export type AlertKind = AlertEvent['kind'];

export const ALERT_KINDS: readonly AlertKind[] = [
  'budget.threshold',
  'budget.exceeded',
  'key.expiring',
  'key.expired',
  'breaker.open',
  'breaker.closed',
  'guardrail.blocked',
  'config.applied',
  'admin.break_glass',
  'session.runaway',
];

export function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value);
}

const DEFAULT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  'budget.threshold': 'warning',
  'budget.exceeded': 'critical',
  'key.expiring': 'warning',
  'key.expired': 'warning',
  'breaker.open': 'critical',
  'breaker.closed': 'info',
  'guardrail.blocked': 'warning',
  'config.applied': 'info',
  'admin.break_glass': 'critical',
  'session.runaway': 'critical',
};

/** The severity an emitter uses unless it has a reason to grade the event itself. */
export function defaultSeverity(kind: AlertKind): AlertSeverity {
  return DEFAULT_SEVERITY[kind];
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event minus the envelope fields {@link makeAlert} fills in. */
export type AlertInput = DistributiveOmit<AlertEvent, 'at' | 'severity'> & {
  at?: string;
  severity?: AlertSeverity;
};

/**
 * Build a complete event: stamps `at` (now) and `severity` (the per-kind default; a
 * flagged-not-blocked runaway session downgrades to `warning`) unless the emitter set
 * them. The one-liner emitters use: `sink.emit(makeAlert({ kind: 'breaker.open', … }))`.
 */
export function makeAlert(input: AlertInput, now: () => Date = () => new Date()): AlertEvent {
  const severity =
    input.severity ??
    (input.kind === 'session.runaway' && input.action === 'flagged'
      ? 'warning'
      : defaultSeverity(input.kind));
  return { ...input, at: input.at ?? now().toISOString(), severity } as AlertEvent;
}
