import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCALATION_STOP_REASONS,
  matchCascade,
  parseCascadePolicy,
  shouldEscalate,
} from './cascade';

describe('parseCascadePolicy', () => {
  it('returns [] for empty/unset', () => {
    expect(parseCascadePolicy(undefined)).toEqual([]);
    expect(parseCascadePolicy('')).toEqual([]);
    expect(parseCascadePolicy('   ')).toEqual([]);
  });

  it('parses policies and defaults stopReasons when omitted', () => {
    const p = parseCascadePolicy(
      JSON.stringify([{ model: 'claude-haiku-*', escalateTo: 'claude-sonnet-4-6' }]),
    );
    expect(p).toEqual([
      {
        model: 'claude-haiku-*',
        escalateTo: 'claude-sonnet-4-6',
        stopReasons: DEFAULT_ESCALATION_STOP_REASONS,
      },
    ]);
  });

  it('honors explicit stopReasons', () => {
    const p = parseCascadePolicy(
      JSON.stringify([{ model: 'a', escalateTo: 'b', stopReasons: ['refusal', 'tool_use'] }]),
    );
    expect(p[0]?.stopReasons).toEqual(['refusal', 'tool_use']);
  });

  it('throws (fails boot) on malformed input', () => {
    expect(() => parseCascadePolicy('{not json')).toThrow(/valid JSON/);
    expect(() => parseCascadePolicy('{}')).toThrow(/must be a JSON array/);
    expect(() => parseCascadePolicy(JSON.stringify([{ model: 'a' }]))).toThrow(/escalateTo/);
    expect(() => parseCascadePolicy(JSON.stringify([{ escalateTo: 'b' }]))).toThrow(/model/);
  });
});

describe('matchCascade', () => {
  const policies = parseCascadePolicy(
    JSON.stringify([
      { model: 'claude-haiku-*', escalateTo: 'claude-sonnet-4-6' },
      { model: 'gpt-4o-mini', escalateTo: 'gpt-4o' },
    ]),
  );

  it('matches by glob and returns the first hit', () => {
    expect(matchCascade(policies, 'claude-haiku-4-5')?.escalateTo).toBe('claude-sonnet-4-6');
    expect(matchCascade(policies, 'gpt-4o-mini')?.escalateTo).toBe('gpt-4o');
    expect(matchCascade(policies, 'claude-opus-5')).toBeUndefined();
  });

  it('never self-cascades (escalateTo === requested model)', () => {
    // A policy whose escalateTo is the requested model is skipped (nothing to escalate to).
    expect(matchCascade(policies, 'claude-sonnet-4-6')).toBeUndefined();
    const self = parseCascadePolicy(JSON.stringify([{ model: 'm', escalateTo: 'm' }]));
    expect(matchCascade(self, 'm')).toBeUndefined();
  });
});

describe('shouldEscalate', () => {
  const policy = { model: 'a', escalateTo: 'b', stopReasons: ['refusal', 'max_tokens'] };

  it('escalates only on a stop_reason in the policy set', () => {
    expect(shouldEscalate(policy, 'refusal')).toBe(true);
    expect(shouldEscalate(policy, 'max_tokens')).toBe(true);
    expect(shouldEscalate(policy, 'end_turn')).toBe(false);
    expect(shouldEscalate(policy, null)).toBe(false);
    expect(shouldEscalate(policy, undefined)).toBe(false);
  });
});
