import { describe, expect, it } from 'vitest';
import { OutlierDetector } from './outlier';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Warm a peer to `ms` EWMA with enough samples to be an eligible baseline. */
function warm(d: OutlierDetector, key: string, ms: number, n = 20): void {
  for (let i = 0; i < n; i++) d.recordLatency(key, ms);
}

describe('OutlierDetector', () => {
  it('ejects a target slow relative to its peers, and never below the floor', () => {
    const c = clock();
    const d = new OutlierDetector({
      minSamples: 20,
      latencyFactor: 3,
      minEjectLatencyMs: 500,
      baseEjectMs: 1000,
      alpha: 1, // track the latest sample exactly for a deterministic test
      now: c.now,
    });
    const peers = ['a', 'b', 'slow'];
    warm(d, 'a', 100); // baseline peer
    warm(d, 'b', 120); // baseline peer

    // 'slow' at 1000ms vs a ~110ms baseline (×3 → 330, floored to 500) → outlier.
    for (let i = 0; i < 19; i++) d.recordLatency('slow', 1000, peers);
    expect(d.isEjected('slow')).toBe(false); // below the sample floor
    d.recordLatency('slow', 1000, peers); // 20th sample → ejected
    expect(d.isEjected('slow')).toBe(true);
  });

  it('does NOT eject when the whole pool is uniformly slow (no outlier)', () => {
    const c = clock();
    const d = new OutlierDetector({ minSamples: 20, latencyFactor: 3, alpha: 1, now: c.now });
    const peers = ['a', 'b', 'c'];
    warm(d, 'a', 5000);
    warm(d, 'b', 5200);
    warm(d, 'c', 5100, 19);
    d.recordLatency('c', 5100, peers); // 20th; 5100 vs ~5100 baseline → not an outlier
    expect(d.isEjected('c')).toBe(false);
  });

  it('never ejects with no eligible peer (single upstream)', () => {
    const c = clock();
    const d = new OutlierDetector({ minSamples: 3, latencyFactor: 2, alpha: 1, now: c.now });
    for (let i = 0; i < 10; i++) d.recordLatency('solo', 99_999, ['solo']);
    expect(d.isEjected('solo')).toBe(false);
  });

  it('self-heals: a re-admitted target that recovers clears immediately (bug #2)', () => {
    const c = clock();
    const d = new OutlierDetector({
      minSamples: 20,
      latencyFactor: 3,
      minEjectLatencyMs: 500,
      baseEjectMs: 1000,
      alpha: 0.2, // the DEFAULT-ish alpha that made the old merged impl sticky
      now: c.now,
    });
    const peers = ['a', 'slow'];
    warm(d, 'a', 100);
    for (let i = 0; i < 20; i++) d.recordLatency('slow', 8000, peers); // slow vs peer → ejected
    expect(d.isEjected('slow')).toBe(true);

    c.advance(1001); // ejection window lapses → re-admitted
    expect(d.isEjected('slow')).toBe(false);
    // First fresh probe is fast: EWMA RESETS to it (not blended from 8000), so the
    // recovered target stays healthy — the old blend kept it ejected for minutes.
    d.recordLatency('slow', 100, peers);
    expect(d.isEjected('slow')).toBe(false);
    expect(d.latency('slow')).toBe(100);
  });

  it('keeps its own backoff counter — no cross-contamination with the breaker (bug #1)', () => {
    const c = clock();
    const d = new OutlierDetector({
      minSamples: 1,
      latencyFactor: 3,
      minEjectLatencyMs: 500,
      baseEjectMs: 1000,
      maxEjectMs: 100_000,
      alpha: 1,
      now: c.now,
    });
    const peers = ['a', 'slow'];
    warm(d, 'a', 100);
    // First latency ejection → base window (1000ms).
    d.recordLatency('slow', 5000, peers);
    expect(d.isEjected('slow')).toBe(true);
    c.advance(1001);
    // Recovered fast probe resets the backoff.
    d.recordLatency('slow', 100, peers);
    expect(d.isEjected('slow')).toBe(false);
    // A later slow spell ejects again from the BASE window (1000ms), not doubled.
    d.recordLatency('slow', 5000, peers);
    expect(d.isEjected('slow')).toBe(true);
    c.advance(1001);
    expect(d.isEjected('slow')).toBe(false); // exactly the base window elapsed
  });
});
