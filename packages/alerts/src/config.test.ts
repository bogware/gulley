import { describe, expect, it } from 'vitest';
import { isValidEventPattern, matchesEventPattern, parseAlertChannels } from './config';

describe('parseAlertChannels', () => {
  it('parses every channel type with the common filter knobs', () => {
    const channels = parseAlertChannels(
      JSON.stringify([
        { type: 'slack', url: 'https://hooks.slack.test/services/T/B/x', events: ['budget.*'] },
        { type: 'teams', url: 'https://teams.test/webhook', minSeverity: 'warning' },
        {
          type: 'pagerduty',
          routingKey: 'R0UT1NGK3Y0000000000000000000000',
          severityMap: { warning: 'error' },
        },
        { type: 'webhook', url: 'https://hooks.test/gulley', secret: 'shared-secret-of-16+' },
        {
          type: 'email',
          smtpUrl: 'smtps://user:pass@smtp.test:465',
          from: 'gulley@acme.test',
          to: ['ops@acme.test'],
          name: 'ops-mail',
          dedupeWindowMs: 0,
        },
      ]),
    );
    expect(channels.map((c) => c.type)).toEqual([
      'slack',
      'teams',
      'pagerduty',
      'webhook',
      'email',
    ]);
    expect(channels[4]).toMatchObject({ name: 'ops-mail', dedupeWindowMs: 0 });
  });

  it('treats an empty value as no channels', () => {
    expect(parseAlertChannels('')).toEqual([]);
    expect(parseAlertChannels('   ')).toEqual([]);
    expect(parseAlertChannels('[]')).toEqual([]);
  });

  it('names the problem by path, without echoing field values', () => {
    expect(() => parseAlertChannels('{not json')).toThrow(/ALERT_CHANNELS is not valid JSON/);
    expect(() => parseAlertChannels(JSON.stringify([{ type: 'pigeon' }]))).toThrow(/\[0\.type\]/);
    const shortSecret = () =>
      parseAlertChannels(
        JSON.stringify([{ type: 'webhook', url: 'https://hooks.test/x', secret: 'tiny' }]),
      );
    expect(shortSecret).toThrow(/\[0\.secret\]: secret must be at least 16 characters/);
    expect(shortSecret).not.toThrow(/tiny/);
    expect(() => parseAlertChannels(JSON.stringify([{ type: 'slack', url: 'not a url' }]))).toThrow(
      /\[0\.url\]/,
    );
    expect(() =>
      parseAlertChannels(JSON.stringify([{ type: 'slack', url: 'https://h.test/x', extra: 1 }])),
    ).toThrow(/Unrecognized key/);
  });

  it('rejects an unknown event pattern so a typo cannot silently filter everything', () => {
    expect(() =>
      parseAlertChannels(
        JSON.stringify([{ type: 'slack', url: 'https://h.test/x', events: ['bugdet.*'] }]),
      ),
    ).toThrow(/unknown event pattern "bugdet\.\*"/);
    expect(() =>
      parseAlertChannels(
        JSON.stringify([{ type: 'slack', url: 'https://h.test/x', events: ['key.expiring'] }]),
      ),
    ).not.toThrow();
  });
});

describe('event patterns', () => {
  it('accepts *, <family>.* and exact kinds', () => {
    expect(isValidEventPattern('*')).toBe(true);
    expect(isValidEventPattern('budget.*')).toBe(true);
    expect(isValidEventPattern('breaker.open')).toBe(true);
    expect(isValidEventPattern('nope.*')).toBe(false);
    expect(isValidEventPattern('budget')).toBe(false);
  });

  it('matches by family prefix or exact kind; absent = everything', () => {
    expect(matchesEventPattern('budget.threshold', undefined)).toBe(true);
    expect(matchesEventPattern('budget.threshold', [])).toBe(true);
    expect(matchesEventPattern('budget.threshold', ['budget.*'])).toBe(true);
    expect(matchesEventPattern('budget.threshold', ['budget.exceeded'])).toBe(false);
    expect(matchesEventPattern('budget.threshold', ['*'])).toBe(true);
    expect(matchesEventPattern('breaker.open', ['budget.*', 'breaker.open'])).toBe(true);
    expect(matchesEventPattern('breaker.open', ['budget.*'])).toBe(false);
  });
});
