import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';
import {
  hrwOrder,
  isFailoverStatus,
  LoadScoreboard,
  orderByWeight,
  p2cOrder,
  residencyCompliant,
  selectCandidates,
} from './select';
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

  it('loadbalance select:cheapest orders by catalog price (rest = failover order)', () => {
    const cb = new CircuitBreaker();
    const price: Record<string, number> = { a: 10, b: 3, c: 7 };
    const s: RoutingStrategy = {
      mode: 'loadbalance',
      select: 'cheapest',
      targets: [target('a'), target('b'), target('c')],
    };
    expect(selectCandidates(s, cb, { costOf: (t) => price[t.name] }).map((t) => t.name)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('loadbalance select:fastest orders by observed EWMA latency', () => {
    const cb = new CircuitBreaker();
    const lat: Record<string, number> = { a: 200, b: 50, c: 120 };
    const outlier = {
      isEjected: () => false,
      latency: (n: string) => lat[n] ?? 0,
    } as unknown as import('./outlier').OutlierDetector;
    const s: RoutingStrategy = {
      mode: 'loadbalance',
      select: 'fastest',
      targets: [target('a'), target('b'), target('c')],
    };
    expect(selectCandidates(s, cb, { outlier }).map((t) => t.name)).toEqual(['b', 'c', 'a']);
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

const rt = (name: string, region?: string, zdr?: boolean): RouteTarget => ({
  ...target(name),
  ...(region ? { region } : {}),
  ...(zdr !== undefined ? { zdr } : {}),
});

describe('residencyCompliant', () => {
  it('allows any target when no constraint is set', () => {
    expect(residencyCompliant(rt('a'))).toBe(true);
    expect(residencyCompliant(rt('a'), new Set(), false)).toBe(true);
  });

  it('enforces the region allowlist and fails closed on an unknown region', () => {
    const eu = new Set(['eu-central-1']);
    expect(residencyCompliant(rt('a', 'eu-central-1'), eu)).toBe(true);
    expect(residencyCompliant(rt('a', 'us-east-1'), eu)).toBe(false);
    expect(residencyCompliant(rt('a'), eu)).toBe(false); // undefined region → closed
  });

  it('enforces requireZdr (only explicit zdr:true qualifies)', () => {
    expect(residencyCompliant(rt('a', 'us', true), undefined, true)).toBe(true);
    expect(residencyCompliant(rt('a', 'us', false), undefined, true)).toBe(false);
    expect(residencyCompliant(rt('a', 'us'), undefined, true)).toBe(false); // undefined zdr → closed
  });
});

describe('selectCandidates residency filtering', () => {
  const eu = new Set(['eu-central-1']);

  it('single mode fails closed when the sole target is out of region', () => {
    const s: RoutingStrategy = { mode: 'single', target: rt('a', 'us-east-1') };
    expect(selectCandidates(s, new CircuitBreaker(), { allowedRegions: eu })).toEqual([]);
  });

  it('single mode passes an in-region target', () => {
    const s: RoutingStrategy = { mode: 'single', target: rt('a', 'eu-central-1') };
    expect(
      selectCandidates(s, new CircuitBreaker(), { allowedRegions: eu }).map((t) => t.name),
    ).toEqual(['a']);
  });

  it('fallback drops out-of-region targets', () => {
    const s: RoutingStrategy = {
      mode: 'fallback',
      targets: [rt('eu', 'eu-central-1'), rt('us', 'us-east-1')],
    };
    expect(
      selectCandidates(s, new CircuitBreaker(), { allowedRegions: eu }).map((t) => t.name),
    ).toEqual(['eu']);
  });

  it('the all-open fallback never re-admits a non-compliant target', () => {
    // The only compliant target is circuit-open; the pool falls back to the compliant
    // base (a half-open probe of `eu`), NOT the healthy-but-non-compliant `us`.
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => 0 });
    cb.recordFailure('eu');
    const s: RoutingStrategy = {
      mode: 'fallback',
      targets: [rt('eu', 'eu-central-1'), rt('us', 'us-east-1')],
    };
    expect(selectCandidates(s, cb, { allowedRegions: eu }).map((t) => t.name)).toEqual(['eu']);
  });

  it('requireZdr keeps only ZDR-flagged targets', () => {
    const s: RoutingStrategy = {
      mode: 'fallback',
      targets: [rt('z', 'us', true), rt('n', 'us', false)],
    };
    expect(
      selectCandidates(s, new CircuitBreaker(), { requireZdr: true }).map((t) => t.name),
    ).toEqual(['z']);
  });

  it('returns [] (fail closed) when no target satisfies the policy', () => {
    const s: RoutingStrategy = {
      mode: 'fallback',
      targets: [rt('us', 'us-east-1'), rt('ap', 'ap-south-1')],
    };
    expect(selectCandidates(s, new CircuitBreaker(), { allowedRegions: eu })).toEqual([]);
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

describe('hrwOrder (session affinity)', () => {
  it('is deterministic per session key and covers every target', () => {
    const targets = [target('a'), target('b'), target('c')];
    const first = hrwOrder(targets, 'sess-42').map((t) => t.name);
    const again = hrwOrder(targets, 'sess-42').map((t) => t.name);
    expect(again).toEqual(first); // sticky: same key → same order
    expect([...first].sort()).toEqual(['a', 'b', 'c']); // no target dropped
  });

  it('spreads different session keys across targets', () => {
    const targets = [target('a'), target('b'), target('c')];
    const primaries = new Set(
      Array.from({ length: 60 }, (_, i) => hrwOrder(targets, `k${i}`)[0]?.name),
    );
    expect(primaries.size).toBeGreaterThan(1); // not all keys land on one target
  });

  it('selectCandidates loadbalance sticks a session', () => {
    const s: RoutingStrategy = { mode: 'loadbalance', targets: [target('a'), target('b')] };
    const cb = new CircuitBreaker();
    const a = selectCandidates(s, cb, { sessionKey: 'u1' }).map((t) => t.name);
    const b = selectCandidates(s, cb, { sessionKey: 'u1' }).map((t) => t.name);
    expect(a).toEqual(b);
  });
});

describe('p2cOrder (least-load)', () => {
  it('prefers the less-loaded of the two sampled targets', () => {
    const sb = new LoadScoreboard();
    const targets = [target('a'), target('b')];
    sb.begin('a'); // a is busier than b
    // rand sequence 0,0.9 samples a then b → picks the least-loaded (b).
    const seq = [0, 0.9];
    let i = 0;
    const order = p2cOrder(targets, sb, () => seq[i++ % seq.length] as number);
    expect(order[0]?.name).toBe('b');
    expect(order.length).toBe(2);
  });

  it('scoreboard begin/end tracks in-flight counts', () => {
    const sb = new LoadScoreboard();
    sb.begin('a');
    sb.begin('a');
    expect(sb.load('a')).toBe(2);
    sb.end('a');
    expect(sb.load('a')).toBe(1);
    sb.end('a');
    sb.end('a'); // never goes negative
    expect(sb.load('a')).toBe(0);
  });
});
