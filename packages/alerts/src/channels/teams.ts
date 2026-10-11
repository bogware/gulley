import { GULLEY_VERSION } from '@gulley/core';
import { alertFields, alertSummary, alertTitle } from '../format';
import type { AlertEvent } from '../types';
import { type AlertChannel, type DeliveryAttempt, type HttpDeps, postJson } from './channel';

const COLOR: Record<AlertEvent['severity'], string> = {
  info: 'Accent',
  warning: 'Warning',
  critical: 'Attention',
};

/** Microsoft Teams (Workflows / incoming webhook) message carrying one Adaptive Card. */
export function teamsPayload(event: AlertEvent): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            {
              type: 'TextBlock',
              size: 'Large',
              weight: 'Bolder',
              color: COLOR[event.severity],
              text: alertTitle(event),
              wrap: true,
            },
            { type: 'TextBlock', text: alertSummary(event), wrap: true },
            {
              type: 'FactSet',
              facts: alertFields(event).map(([title, value]) => ({ title, value })),
            },
            {
              type: 'TextBlock',
              size: 'Small',
              isSubtle: true,
              text: `${event.severity} · ${event.kind} · gulley ${GULLEY_VERSION}`,
              wrap: true,
            },
          ],
        },
      },
    ],
  };
}

export class TeamsChannel implements AlertChannel {
  readonly type = 'teams';
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly deps: HttpDeps,
  ) {}

  async send(event: AlertEvent, _attempt: DeliveryAttempt): Promise<void> {
    await postJson(this.deps, this.url, {}, JSON.stringify(teamsPayload(event)));
  }
}
