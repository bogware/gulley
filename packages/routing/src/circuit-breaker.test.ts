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
