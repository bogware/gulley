import { AlertDispatcher, noopAlertSink } from '@gulley/alerts';
import { describe, expect, it } from 'vitest';
import { buildAlertSink } from './alerts';
import { loadConfig } from './config';

const SLACK = JSON.stringify([{ type: 'slack', url: 'https://hooks.slack.test/services/T/B/x' }]);

describe('buildAlertSink', () => {
  it('is the no-op sink when ALERT_CHANNELS is unset or empty', () => {
    expect(buildAlertSink(loadConfig({}))).toBe(noopAlertSink);
    expect(buildAlertSink(loadConfig({ ALERT_CHANNELS: '[]' }))).toBe(noopAlertSink);
  });

  it('builds a dispatcher over the configured channels', () => {
    const sink = buildAlertSink(
      loadConfig({ ALERT_CHANNELS: SLACK, OUTBOUND_HOST_ALLOWLIST: 'hooks.slack.test' }),
    );
    expect(sink).toBeInstanceOf(AlertDispatcher);
    expect((sink as AlertDispatcher).describe()).toEqual([
      {
        name: 'slack',
        type: 'slack',
        events: undefined,
        minSeverity: 'info',
        dedupeWindowMs: 60_000,
      },
    ]);
  });

  it('fails boot on a malformed channel list or a target off the egress allowlist', () => {
    expect(() => buildAlertSink(loadConfig({ ALERT_CHANNELS: '{"type":"slack"}' }))).toThrow(
      /ALERT_CHANNELS invalid/,
    );
    expect(() =>
      buildAlertSink(loadConfig({ ALERT_CHANNELS: SLACK, OUTBOUND_HOST_ALLOWLIST: 'other.test' })),
    ).toThrow(/not in outbound allowlist/);
    // Air-gapped with no allowlist denies everything, like every other outbound.
    expect(() => buildAlertSink(loadConfig({ ALERT_CHANNELS: SLACK, AIR_GAPPED: 'true' }))).toThrow(
      /air-gapped/,
    );
  });

  it('requires https outside development', () => {
    const plain = JSON.stringify([{ type: 'slack', url: 'http://hooks.slack.test/x' }]);
    expect(() => buildAlertSink(loadConfig({ ALERT_CHANNELS: plain }))).not.toThrow();
    expect(() =>
      buildAlertSink(loadConfig({ ALERT_CHANNELS: plain, NODE_ENV: 'production' })),
    ).toThrow(/non-https/);
  });
});
