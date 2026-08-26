import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('CircuitBreaker (graded)', () => {
  it('opens on consecutive failures and honors a Retry-After floor', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: c.now });
    for (let i = 0; i < 3; i++) b.recordFailure('t');
    expect(b.isOpen('t')).toBe(true);
    c.advance(1001);
    expect(b.isOpen('t')).toBe(false); // base cooldown elapsed

    b.recordFailure('t', 5000); // Retry-After 5s floors the cooldown
    expect(b.isOpen('t')).toBe(true);
    c.advance(4000);
    expect(b.isOpen('t')).toBe(true); // still within the 5s window
    c.advance(1001);
    expect(b.isOpen('t')).toBe(false);
  });

  it('applies multiplicative backoff and resets it after a half-open recovery', () => {
    const c = clock();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      maxCooldownMs: 10_000,
      now: c.now,
    });
    b.recordFailure('t'); // ejection 1 → 1000ms
    c.advance(1001);
    expect(b.isOpen('t')).toBe(false);
    b.recordFailure('t'); // ejection 2 → 2000ms
    c.advance(1500);
    expect(b.isOpen('t')).toBe(true); // 2000 > 1500
    c.advance(600);
    expect(b.isOpen('t')).toBe(false); // past 2000

    b.recordSuccess('t'); // half-open recovery resets the backoff
    b.recordFailure('t'); // ejection back to 1 → 1000ms
    c.advance(1001);
    expect(b.isOpen('t')).toBe(false);
  });

  it('passively ejects a slow (but not erroring) outlier and self-heals on a fast probe', () => {
    const c = clock();
    const b = new CircuitBreaker({
      latencyThresholdMs: 500,
      minLatencySamples: 3,
      latencyEjectionMs: 1000,
      alpha: 1, // EWMA tracks the latest sample exactly, for a deterministic test
      now: c.now,
    });
    // Below the sample floor: measured but never ejected.
    b.recordLatency('slow', 900);
    b.recordLatency('slow', 900);
    expect(b.isOpen('slow')).toBe(false);
    b.recordLatency('slow', 900); // 3rd sample, EWMA 900 ≥ 500 → ejected
    expect(b.isOpen('slow')).toBe(true);
    expect(b.latencyMs('slow')).toBe(900);

    c.advance(1001); // ejection window elapses → half-open
    expect(b.isOpen('slow')).toBe(false);
    b.recordLatency('slow', 100); // fast probe pulls EWMA under the threshold
    expect(b.isOpen('slow')).toBe(false); // stays healthy
  });

  it('does not eject on latency when the threshold is unset (opt-in)', () => {
    const c = clock();
    const b = new CircuitBreaker({ minLatencySamples: 1, alpha: 1, now: c.now });
    for (let i = 0; i < 5; i++) b.recordLatency('t', 10_000);
    expect(b.isOpen('t')).toBe(false); // latency ejection disabled by default
    expect(b.latencyMs('t')).toBe(10_000); // still tracked for observability
  });

  it('ejects on a high EWMA error rate with no consecutive streak', () => {
    const c = clock();
    const b = new CircuitBreaker({
      failureThreshold: 100, // consecutive rule can never trip here
      cooldownMs: 1000,
      minSamples: 10,
      errorRateThreshold: 0.5,
      alpha: 0.5,
      now: c.now,
    });
    let opened = false;
    for (let i = 0; i < 40 && !opened; i++) {
      b.recordFailure('t');
      if (b.isOpen('t')) {
        opened = true;
        break;
      }
      b.recordSuccess('t'); // resets consecutive but not the EWMA rate
    }
    expect(opened).toBe(true);
    expect(b.errorRate('t')).toBeGreaterThan(0.5);
  });
});
