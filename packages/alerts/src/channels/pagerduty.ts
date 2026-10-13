import { alertEntity, alertSummary } from '../format';
import type { AlertEvent, AlertSeverity } from '../types';
import { type AlertChannel, type DeliveryAttempt, type HttpDeps, postJson } from './channel';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

const DEFAULT_SEVERITY_MAP: Record<AlertSeverity, PagerDutySeverity> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

/** `${kind}:${entity}`; a `breaker.closed` resolves the matching `breaker.open`. */
export function pagerdutyDedupKey(event: AlertEvent): string {
  const kind = event.kind === 'breaker.closed' ? 'breaker.open' : event.kind;
  return `${kind}:${alertEntity(event)}`;
}

/** Events API v2 body. `breaker.closed` is a `resolve` of the open incident; everything
 *  else is a `trigger` keyed so a repeat of the same (kind, entity) dedupes server-side. */
export function pagerdutyPayload(
  event: AlertEvent,
  routingKey: string,
  opts: { severityMap?: Partial<Record<AlertSeverity, PagerDutySeverity>>; source?: string } = {},
): Record<string, unknown> {
  const dedupKey = pagerdutyDedupKey(event);
  if (event.kind === 'breaker.closed') {
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  const severity = opts.severityMap?.[event.severity] ?? DEFAULT_SEVERITY_MAP[event.severity];
  const { at: _at, severity: _sev, kind: _kind, ...details } = event;
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: alertSummary(event).slice(0, 1024),
      source: opts.source ?? 'gulley',
      severity,
      timestamp: event.at,
      component: componentOf(event),
      group: 'workspaceId' in event && event.workspaceId ? event.workspaceId : undefined,
      class: event.kind,
      custom_details: details,
    },
  };
}

function componentOf(event: AlertEvent): string | undefined {
  switch (event.kind) {
    case 'breaker.open':
    case 'breaker.closed':
      return event.provider;
    case 'budget.threshold':
    case 'budget.exceeded':
      return event.scopeKind;
    default:
      return undefined;
  }
}

export class PagerDutyChannel implements AlertChannel {
  readonly type = 'pagerduty';
  constructor(
    readonly name: string,
    private readonly routingKey: string,
    private readonly deps: HttpDeps & {
      severityMap?: Partial<Record<AlertSeverity, PagerDutySeverity>>;
      source?: string;
      url?: string;
    },
  ) {}

  async send(event: AlertEvent, _attempt: DeliveryAttempt): Promise<void> {
    const body = JSON.stringify(
      pagerdutyPayload(event, this.routingKey, {
        severityMap: this.deps.severityMap,
        source: this.deps.source,
      }),
    );
    await postJson(this.deps, this.deps.url ?? PAGERDUTY_EVENTS_URL, {}, body);
  }
}
