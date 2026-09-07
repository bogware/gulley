import { describe, expect, it } from 'vitest';

import { parseBudgetAttrCaps, parseBudgetModelCaps } from './context';

describe('parseBudgetModelCaps', () => {
  it('returns an empty map when unset', () => {
    expect(parseBudgetModelCaps(undefined).size).toBe(0);
  });

  it('keys each cap by its `model:<model>` scope', () => {
    const m = parseBudgetModelCaps(
      JSON.stringify({
        'claude-opus-4-8': { capMicroUsd: 10_000_000, periodSeconds: 86_400 },
        'gpt-4o': { capMicroUsd: 500 },
      }),
    );
    expect(m.get('model:claude-opus-4-8')).toEqual({
      capMicroUsd: 10_000_000,
      periodSeconds: 86_400,
    });
    expect(m.get('model:gpt-4o')).toEqual({ capMicroUsd: 500 });
  });

  it('throws on invalid JSON rather than silently disabling caps', () => {
    expect(() => parseBudgetModelCaps('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on a non-object payload', () => {
    expect(() => parseBudgetModelCaps('[1,2,3]')).toThrow(/must be a JSON object/);
  });

  it('rejects a non-positive or non-numeric cap', () => {
    expect(() => parseBudgetModelCaps(JSON.stringify({ m: { capMicroUsd: 0 } }))).toThrow(
      /positive number/,
    );
    expect(() => parseBudgetModelCaps(JSON.stringify({ m: { capMicroUsd: 'x' } }))).toThrow(
      /positive number/,
    );
  });

  it('drops a non-object entry but keeps the valid ones', () => {
    const m = parseBudgetModelCaps(JSON.stringify({ bad: 5, good: { capMicroUsd: 100 } }));
    expect(m.has('model:bad')).toBe(false);
    expect(m.get('model:good')).toEqual({ capMicroUsd: 100 });
  });

  it('ignores a non-positive period (treats the cap as period-less)', () => {
    const m = parseBudgetModelCaps(JSON.stringify({ m: { capMicroUsd: 100, periodSeconds: 0 } }));
    expect(m.get('model:m')).toEqual({ capMicroUsd: 100 });
  });
});

describe('parseBudgetAttrCaps', () => {
  it('returns an empty map when unset', () => {
    expect(parseBudgetAttrCaps(undefined).size).toBe(0);
  });

  it('keys each cap by its bare attribution key and honors an explicit period', () => {
    const m = parseBudgetAttrCaps(
      JSON.stringify({ session: { capMicroUsd: 5_000, periodSeconds: 3_600 } }),
    );
    expect(m.get('session')).toEqual({ capMicroUsd: 5_000, periodSeconds: 3_600 });
  });

  it('ALWAYS applies a rolling window: an omitted period defaults to 24h', () => {
    // Regression: the attr-cap key value is client-controlled, so a TTL-less
    // counter on the noeviction Redis would grow unbounded (key-exhaustion DoS).
    // Unlike model caps, an omitted/invalid period must NOT yield a lifetime cap.
    const m = parseBudgetAttrCaps(JSON.stringify({ session: { capMicroUsd: 5_000 } }));
    expect(m.get('session')).toEqual({ capMicroUsd: 5_000, periodSeconds: 86_400 });
  });

  it('defaults the window when a non-positive period is given (never period-less)', () => {
    const m = parseBudgetAttrCaps(
      JSON.stringify({ session: { capMicroUsd: 5_000, periodSeconds: 0 } }),
    );
    expect(m.get('session')?.periodSeconds).toBe(86_400);
  });

  it('throws on invalid JSON / non-object / non-positive cap', () => {
    expect(() => parseBudgetAttrCaps('{nope')).toThrow(/not valid JSON/);
    expect(() => parseBudgetAttrCaps('[1]')).toThrow(/must be a JSON object/);
    expect(() => parseBudgetAttrCaps(JSON.stringify({ session: { capMicroUsd: -1 } }))).toThrow(
      /positive number/,
    );
  });
});
