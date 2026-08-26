import { describe, expect, it } from 'vitest';
import { parseDurationMs, parseRetryAfterMs } from './retry-after';

const NOW = 1_700_000_000_000; // fixed clock for deterministic absolute-time math

describe('parseDurationMs', () => {
  it('parses Go-style durations and bare seconds', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('88ms')).toBe(88);
    expect(parseDurationMs('1h30m')).toBe(5_400_000);
    expect(parseDurationMs('30')).toBe(30_000); // bare number = seconds
    expect(parseDurationMs('')).toBeUndefined();
    expect(parseDurationMs('soon')).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it('honors Retry-After delta-seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '3' }, NOW)).toBe(3000);
  });

  it('honors Retry-After HTTP-date', () => {
    const when = new Date(NOW + 10_000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': when }, NOW)).toBe(10_000);
  });

  it('honors Azure/OpenAI retry-after-ms', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '1500' }, NOW)).toBe(1500);
  });

  it('falls back to the soonest OpenAI x-ratelimit-reset bucket', () => {
    expect(
      parseRetryAfterMs(
        { 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-reset-tokens': '2s' },
        NOW,
      ),
    ).toBe(2000);
  });

  it('parses Anthropic RFC3339 reset timestamps', () => {
    const reset = new Date(NOW + 30_000).toISOString();
    expect(parseRetryAfterMs({ 'anthropic-ratelimit-tokens-reset': reset }, NOW)).toBe(30_000);
  });

  it('prefers the authoritative Retry-After over reset hints', () => {
    expect(parseRetryAfterMs({ 'retry-after': '5', 'x-ratelimit-reset-tokens': '1s' }, NOW)).toBe(
      5000,
    );
  });

  it('returns undefined when no backoff signal is present', () => {
    expect(parseRetryAfterMs({ 'content-type': 'application/json' }, NOW)).toBeUndefined();
  });
});
