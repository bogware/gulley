import { GULLEY_VERSION } from '@gulley/core';
import { alertFields, alertSummary, alertTitle } from '../format';
import type { AlertEvent } from '../types';
import { type AlertChannel, type DeliveryAttempt, type HttpDeps, postJson } from './channel';

const ICON: Record<AlertEvent['severity'], string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

/** Slack Incoming Webhook body: a `text` fallback plus Block Kit blocks. */
export function slackPayload(event: AlertEvent): Record<string, unknown> {
  const fields = alertFields(event)
    .slice(0, 10) // Block Kit allows at most 10 fields per section
    .map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` }));
  return {
    text: `${ICON[event.severity]} ${alertTitle(event)}: ${alertSummary(event)}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${alertTitle(event)}`, emoji: true },
      },
      { type: 'section', text: { type: 'mrkdwn', text: alertSummary(event) } },
      { type: 'section', fields },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${ICON[event.severity]} ${event.severity} · \`${event.kind}\` · gulley ${GULLEY_VERSION}`,
          },
        ],
      },
    ],
  };
}

export class SlackChannel implements AlertChannel {
  readonly type = 'slack';
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly deps: HttpDeps,
  ) {}

  async send(event: AlertEvent, _attempt: DeliveryAttempt): Promise<void> {
    await postJson(this.deps, this.url, {}, JSON.stringify(slackPayload(event)));
  }
}
