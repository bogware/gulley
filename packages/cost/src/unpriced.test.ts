import { describe, expect, it } from 'vitest';
import { computeCost } from './compute';

const usage = {
  inputTokens: 1_000,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 100,
  seen: true,
};

describe('computeCost — a non-finite rate is UNPRICED, never NaN', () => {
  it('a resolver returning NaN/Infinity rates yields priced:false and zero dollars', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = computeCost('anthropic', 'claude-mystery', usage, () => ({
        input: bad,
        output: 1,
      }));
      expect(c.priced).toBe(false);
      expect(c.totalUsd).toBe(0);
      expect(Number.isNaN(c.totalUsd)).toBe(false);
      expect(c.totalInputTokens).toBe(1_000); // tokens still metered
    }
  });

  it('a finite override still prices normally', () => {
    const c = computeCost('anthropic', 'claude-mystery', usage, () => ({ input: 3, output: 15 }));
    expect(c.priced).toBe(true);
    expect(c.totalUsd).toBeCloseTo(0.003 + 0.0015, 9);
  });
});
