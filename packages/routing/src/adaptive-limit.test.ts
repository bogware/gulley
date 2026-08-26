import { describe, expect, it } from 'vitest';
import { AdaptiveLimiter } from './adaptive-limit';

describe('AdaptiveLimiter', () => {
  it('gates admission at floor(limit) and admits again after a release', () => {
    const l = new AdaptiveLimiter({ minLimit: 1, initialLimit: 3, maxLimit: 100 });
    expect(l.tryAcquire('t')).toBe(true); // 1
    expect(l.tryAcquire('t')).toBe(true); // 2
    expect(l.tryAcquire('t')).toBe(true); // 3
    expect(l.inFlight('t')).toBe(3);
    expect(l.tryAcquire('t')).toBe(false); // at ceiling
    l.record('t', 50, false); // release one
    expect(l.inFlight('t')).toBe(2);
    expect(l.tryAcquire('t')).toBe(true); // room again
  });

  it('multiplicatively decreases the limit on a dropped sample', () => {
    const l = new AdaptiveLimiter({ minLimit: 2, initialLimit: 20, backoffRatio: 0.5 });
    l.tryAcquire('t');
    l.record('t', 100, true); // dropped → 20 * 0.5 = 10
    expect(l.currentLimit('t')).toBe(10);
    l.tryAcquire('t');
    l.record('t', 100, true); // 10 * 0.5 = 5
    expect(l.currentLimit('t')).toBe(5);
  });

  it('never decreases below minLimit even on repeated drops', () => {
    const l = new AdaptiveLimiter({ minLimit: 3, initialLimit: 8, backoffRatio: 0.5 });
    for (let i = 0; i < 20; i++) {
      l.tryAcquire('t');
      l.record('t', 100, true);
    }
    expect(l.currentLimit('t')).toBe(3);
  });

  it('grows the limit when answering near its no-load latency at saturation', () => {
    const l = new AdaptiveLimiter({ minLimit: 2, initialLimit: 10, maxLimit: 100, smoothing: 0.5 });
    // Saturate: 10 in flight.
    for (let i = 0; i < 10; i++) expect(l.tryAcquire('t')).toBe(true);
    const before = l.currentLimit('t');
    // A fast sample at saturation (establishes rttNoLoad, gradient = 1).
    l.record('t', 100, false);
    expect(l.currentLimit('t')).toBeGreaterThan(before);
  });

  it('shrinks the limit when latency climbs above the no-load baseline', () => {
    const l = new AdaptiveLimiter({ minLimit: 2, initialLimit: 12, maxLimit: 100, smoothing: 0.5 });
    for (let i = 0; i < 12; i++) l.tryAcquire('t');
    l.record('t', 100, false); // baseline 100
    const mid = l.currentLimit('t');
    // Re-saturate and feed a slow sample (10x baseline → gradient floored at 0.5).
    for (let i = l.inFlight('t'); i < mid; i++) l.tryAcquire('t');
    l.record('t', 1000, false);
    expect(l.currentLimit('t')).toBeLessThan(mid);
  });

  it('does not inflate the limit from idle (well-below-saturation) traffic', () => {
    const l = new AdaptiveLimiter({ minLimit: 2, initialLimit: 20, maxLimit: 100, smoothing: 0.5 });
    // One request at a time, very fast: in-flight is far below limit/2, so the
    // limit must stay put (no unbounded growth on a quiet target).
    for (let i = 0; i < 50; i++) {
      l.tryAcquire('t');
      l.record('t', 5, false);
    }
    expect(l.currentLimit('t')).toBe(20);
  });

  it('never exceeds maxLimit', () => {
    const l = new AdaptiveLimiter({ minLimit: 2, initialLimit: 8, maxLimit: 10, smoothing: 1 });
    for (let round = 0; round < 50; round++) {
      const cap = l.currentLimit('t');
      for (let i = 0; i < cap; i++) l.tryAcquire('t');
      for (let i = 0; i < cap; i++) l.record('t', 10, false); // fast, at saturation
    }
    expect(l.currentLimit('t')).toBeLessThanOrEqual(10);
  });
});
