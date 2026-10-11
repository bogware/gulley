import type { AlertEvent, AlertKind } from './types';

/**
 * Shared rendering for every channel: the entity an event is "about" (dedupe key,
 * PagerDuty dedup_key, email subject), a one-line summary, and the detail fields the
 * card-style channels lay out. Pure, no secrets.
 */

/** The stable identity of what an event is about — the storm-control key. */
export function alertEntity(event: AlertEvent): string {
  switch (event.kind) {
    case 'budget.threshold':
    case 'budget.exceeded':
      return event.entity;
    case 'key.expiring':
    case 'key.expired':
      return event.keyId;
    case 'breaker.open':
    case 'breaker.closed':
      return event.target;
    case 'guardrail.blocked':
      return `${event.workspaceId}/${event.principalId}`;
    case 'config.applied':
      return `v${event.version}`;
    case 'admin.break_glass':
      return event.actor;
    case 'session.runaway':
      return event.session;
  }
}

const TITLES: Record<AlertKind, string> = {
  'budget.threshold': 'Budget threshold crossed',
  'budget.exceeded': 'Budget exceeded',
  'key.expiring': 'Virtual key expiring',
  'key.expired': 'Virtual key expired',
  'breaker.open': 'Upstream circuit opened',
  'breaker.closed': 'Upstream circuit closed',
  'guardrail.blocked': 'Guardrail blocked a request',
  'config.applied': 'Configuration applied',
  'admin.break_glass': 'Break-glass session minted',
  'session.runaway': 'Runaway agent session',
};

export function alertTitle(event: AlertEvent): string {
  return TITLES[event.kind];
}

export function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(microUsd >= 1_000_000 ? 2 : 4)}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/** One human line, safe for a Slack `text` fallback or a PagerDuty summary. */
export function alertSummary(event: AlertEvent): string {
  switch (event.kind) {
    case 'budget.threshold':
      return `${event.scopeKind} ${event.entity} is at ${pct(event.utilization)} of its ${event.window} budget (${usd(event.usedMicroUsd)} of ${usd(event.capMicroUsd)}; threshold ${pct(event.threshold)})`;
    case 'budget.exceeded':
      return `${event.scopeKind} ${event.entity} exhausted its ${event.window} budget (${usd(event.usedMicroUsd)} of ${usd(event.capMicroUsd)}); request ${event.requestId} refused`;
    case 'key.expiring':
      return `key "${event.displayName}" (${event.keyId}) in workspace ${event.workspaceId} expires in ${event.daysLeft} day${event.daysLeft === 1 ? '' : 's'} (${event.expiresAt})`;
    case 'key.expired':
      return `key "${event.displayName}" (${event.keyId}) in workspace ${event.workspaceId} expired at ${event.expiresAt}`;
    case 'breaker.open':
      return `circuit breaker OPEN for ${event.target} (${event.provider}); traffic is failing over`;
    case 'breaker.closed':
      return `circuit breaker closed for ${event.target} (${event.provider}); target re-admitted`;
    case 'guardrail.blocked':
      return `${event.direction} guardrail blocked a ${event.surface} request for ${event.principalId} in workspace ${event.workspaceId} [${event.categories.join(', ')}]${event.reason ? `: ${event.reason}` : ''}`;
    case 'config.applied':
      return `config version ${event.version} (${event.contentHash.slice(0, 12)}) applied by ${event.actor}`;
    case 'admin.break_glass':
      return `break-glass owner session minted by ${event.actor} until ${event.expiresAt}: ${event.reason}`;
    case 'session.runaway':
      return `session ${event.session} in workspace ${event.workspaceId} ${event.action} at ${usd(event.costMicroUsd)} (baseline ${usd(event.baselineMicroUsd)}, org p99 ${usd(event.orgP99MicroUsd)})`;
  }
}

/** Label/value pairs for cards and the email body (ordered, strings only). */
export function alertFields(event: AlertEvent): Array<[string, string]> {
  const common: Array<[string, string]> = [
    ['Severity', event.severity],
    ['At', event.at],
  ];
  switch (event.kind) {
    case 'budget.threshold':
      return [
        ['Scope', `${event.scopeKind}:${event.entity}`],
        ['Window', event.window],
        ['Threshold', pct(event.threshold)],
        ['Utilization', pct(event.utilization)],
        ['Used', usd(event.usedMicroUsd)],
        ['Cap', usd(event.capMicroUsd)],
        ...(event.workspaceId ? [['Workspace', event.workspaceId] as [string, string]] : []),
        ...common,
      ];
    case 'budget.exceeded':
      return [
        ['Scope', `${event.scopeKind}:${event.entity}`],
        ['Window', event.window],
        ['Used', usd(event.usedMicroUsd)],
        ['Cap', usd(event.capMicroUsd)],
        ['Request', event.requestId],
        ...(event.workspaceId ? [['Workspace', event.workspaceId] as [string, string]] : []),
        ...common,
      ];
    case 'key.expiring':
      return [
        ['Key', event.displayName],
        ['Key id', event.keyId],
        ['Workspace', event.workspaceId],
        ['Expires', event.expiresAt],
        ['Days left', String(event.daysLeft)],
        ...common,
      ];
    case 'key.expired':
      return [
        ['Key', event.displayName],
        ['Key id', event.keyId],
        ['Workspace', event.workspaceId],
        ['Expired', event.expiresAt],
        ...common,
      ];
    case 'breaker.open':
    case 'breaker.closed':
      return [['Target', event.target], ['Provider', event.provider], ...common];
    case 'guardrail.blocked':
      return [
        ['Direction', event.direction],
        ['Surface', event.surface],
        ['Workspace', event.workspaceId],
        ['Principal', event.principalId],
        ['Categories', event.categories.join(', ') || '-'],
        ...(event.reason ? [['Reason', event.reason] as [string, string]] : []),
        ...common,
      ];
    case 'config.applied':
      return [
        ['Version', String(event.version)],
        ['Content hash', event.contentHash],
        ['Actor', event.actor],
        ...common,
      ];
    case 'admin.break_glass':
      return [
        ['Actor', event.actor],
        ['Reason', event.reason],
        ['Expires', event.expiresAt],
        ...common,
      ];
    case 'session.runaway':
      return [
        ['Session', event.session],
        ['Workspace', event.workspaceId],
        ...(event.principalId ? [['Principal', event.principalId] as [string, string]] : []),
        ['Action', event.action],
        ['Cost', usd(event.costMicroUsd)],
        ['Baseline', usd(event.baselineMicroUsd)],
        ['Org p99', usd(event.orgP99MicroUsd)],
        ...common,
      ];
  }
}

/** Plain-text rendering (email body, webhook-less fallbacks). */
export function alertText(event: AlertEvent): string {
  const lines = [
    `${alertTitle(event)} [${event.severity}]`,
    '',
    alertSummary(event),
    '',
    ...alertFields(event).map(([k, v]) => `${k}: ${v}`),
    '',
    `kind: ${event.kind}`,
    `entity: ${alertEntity(event)}`,
  ];
  return lines.join('\n');
}
