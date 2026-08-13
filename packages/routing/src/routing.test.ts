import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';
import { isFailoverStatus, orderByWeight, selectCandidates } from './select';
import type { RouteTarget, RoutingStrategy } from './types';

const fakeAdapter: RouteTarget['adapter'] = {
  name: 'test',
  forward: async () => ({ statusCode: 200, headers: {}, body: null as never }),
};

function target(name: string, weight?: number): RouteTarget {
  return {
    name,
    provider: 'test',
    adapter: fakeAdapter,
    credential: { scheme: 'bearer', value: 'x' },
    upstreamPath: '/x',
    weight,
  };
}

describe('CircuitBreaker', () => {
  it('opens at the threshold, half-opens after cooldown, resets on success', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => t });

    cb.recordFailure('a');
    expect(cb.isOpen('a')).toBe(false);
    cb.recordFailure('a');
    expect(cb.isOpen('a')).toBe(true);

    t = 150;
    expect(cb.isOpen('a')).toBe(false); // half-open
    cb.recordSuccess('a');
    expect(cb.isOpen('a')).toBe(false);
  });
});

describe('isFailoverStatus', () => {
  it('fails over on transient statuses but not terminal 4xx', () => {
    const fb: RoutingStrategy = { mode: 'fallback', targets: [] };
    expect(isFailoverStatus(fb, 429)).toBe(true);
    expect(isFailoverStatus(fb, 503)).toBe(true);
    expect(isFailoverStatus(fb, 400)).toBe(false);
    expect(isFailoverStatus(fb, 404)).toBe(false);
  });

  it('honors custom onStatusCodes', () => {
    const fb: RoutingStrategy = { mode: 'fallback', targets: [], onStatusCodes: [418] };
    expect(isFailoverStatus(fb, 418)).toBe(true);
    expect(isFailoverStatus(fb, 429)).toBe(false);
  });
});

describe('selectCandidates', () => {
  it('fallback preserves order and skips open circuits', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => 0 });
    cb.recordFailure('b'); // opens b (threshold 1)
    const s: RoutingStrategy = {
      mode: 'fallback',
      targets: [target('a'), target('b'), target('c')],
    };
    expect(selectCandidates(s, cb, () => 0).map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('returns all targets when every circuit is open (half-open attempt)', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => 0 });
    cb.recordFailure('a');
    cb.recordFailure('b');
    const s: RoutingStrategy = { mode: 'fallback', targets: [target('a'), target('b')] };
    expect(
      selectCandidates(s, cb)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('single returns its one target', () => {
    expect(
      selectCandidates({ mode: 'single', target: target('a') }, new CircuitBreaker()).map(
        (t) => t.name,
      ),
    ).toEqual(['a']);
  });
});

describe('orderByWeight', () => {
  it('draws the primary pick by weight', () => {
    const targets = [target('a', 1), target('b', 9)];
    expect(orderByWeight(targets, () => 0)[0]?.name).toBe('a');
    expect(orderByWeight(targets, () => 0.99)[0]?.name).toBe('b');
    // Every target still appears in the failover order.
    expect(orderByWeight(targets, () => 0.99).length).toBe(2);
  });
});
