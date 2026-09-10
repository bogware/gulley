import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';
import type { BreakerSync } from './breaker-sync';

/** In-memory sync standing in for a shared Redis snapshot across replicas. */
class FakeSync implements BreakerSync {
  readonly map = new Map<string, number>();
  publishOpen(key: string, openUntil: number): void {
    this.map.set(key, openUntil);
  }
  sharedOpenUntil(key: string): number {
    return this.map.get(key) ?? 0;
  }
}

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

  it('broadcasts local ejections and honors a peer replica ejection', () => {
    const c = clock();
    const shared = new FakeSync();
    // Two replicas over ONE shared snapshot.
    const a = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      sync: shared,
      now: c.now,
    });
    const b = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
      sync: shared,
      now: c.now,
    });

    // Replica A trips locally; B has seen no failures of its own.
    a.recordFailure('t');
    a.recordFailure('t');
    expect(a.isOpen('t')).toBe(true);
    expect(shared.map.get('t')).toBe(1000);
    // B honors A's ejection through the shared snapshot despite zero local faults.
    expect(b.isOpen('t')).toBe(true);

    // The shared floor self-heals with the cooldown; both re-admit after it.
    c.advance(1001);
    expect(a.isOpen('t')).toBe(false);
    expect(b.isOpen('t')).toBe(false);
  });

  it('does not report open from a stale shared entry that has expired', () => {
    const c = clock();
    const shared = new FakeSync();
    shared.map.set('t', 500); // a peer ejected until t=500
    const b = new CircuitBreaker({ sync: shared, now: c.now });
    expect(b.isOpen('t')).toBe(true);
    c.advance(500);
    expect(b.isOpen('t')).toBe(false); // openUntil is exclusive; healthy at/after
  });

  describe('half-open single-probe gate (tryProbe)', () => {
    it('admits everyone when healthy or never-seen (no side effects on isOpen)', () => {
      const c = clock();
      const b = new CircuitBreaker({ now: c.now });
      expect(b.tryProbe('never-seen')).toBe(true);
      b.recordSuccess('t'); // seen, healthy
      expect(b.tryProbe('t')).toBe(true);
      expect(b.tryProbe('t')).toBe(true); // repeatable — no token held while healthy
    });

    it('admits the last-resort attempt while a target is still fully open (cooldown active)', () => {
      const c = clock();
      const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });
      b.recordFailure('t'); // open until 1000
      expect(b.isOpen('t')).toBe(true);
      // A fully-open target only reaches dispatch as a last resort ("a probe beats a
      // hard fail") — tryProbe must not block it and must not consume a token.
      expect(b.tryProbe('t')).toBe(true);
      expect(b.tryProbe('t')).toBe(true);
    });

    it('admits exactly one probe in the half-open window and sheds concurrent callers', () => {
      const c = clock();
      const b = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        probeTimeoutMs: 5000,
        now: c.now,
      });
      b.recordFailure('t'); // open until 1000
      c.advance(1001); // cooldown expired → half-open
      expect(b.isOpen('t')).toBe(false); // selection still sees it as healthy
      expect(b.tryProbe('t')).toBe(true); // first caller wins the probe token
      expect(b.tryProbe('t')).toBe(false); // concurrent callers are shed
      expect(b.tryProbe('t')).toBe(false);
    });

    it('closes on a probe success so the whole fleet is re-admitted', () => {
      const c = clock();
      const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });
      b.recordFailure('t');
      c.advance(1001);
      expect(b.tryProbe('t')).toBe(true);
      b.recordSuccess('t'); // probe succeeded → recovered
      expect(b.tryProbe('t')).toBe(true); // token released; normal dispatch resumes
      expect(b.tryProbe('t')).toBe(true);
    });

    it('re-opens on a probe failure (isOpen true again) and does not wedge afterward', () => {
      const c = clock();
      const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });
      b.recordFailure('t');
      c.advance(1001);
      expect(b.tryProbe('t')).toBe(true); // probe granted
      b.recordFailure('t'); // probe failed → re-open (backoff doubles) + token cleared
      expect(b.isOpen('t')).toBe(true);
      c.advance(2001); // second cooldown (2000ms) elapses
      expect(b.tryProbe('t')).toBe(true); // a fresh probe is admitted, not wedged
    });

    it('self-heals a granted-but-never-dispatched probe token after probeTimeoutMs', () => {
      const c = clock();
      const b = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
        probeTimeoutMs: 3000,
        now: c.now,
      });
      b.recordFailure('t');
      c.advance(1001);
      expect(b.tryProbe('t')).toBe(true); // token claimed, but the caller never dispatches
      expect(b.tryProbe('t')).toBe(false); // still held
      c.advance(3001); // token lifetime elapses without a record*()
      expect(b.tryProbe('t')).toBe(true); // self-healed — another caller may probe
    });
  });
});
