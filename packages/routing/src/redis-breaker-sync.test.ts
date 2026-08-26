import { describe, expect, it } from 'vitest';
import { type BreakerRedis, RedisBreakerSync } from './breaker-sync';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Minimal in-memory Redis stand-in: only `set … PX` and `mget`, with TTL
 *  expiry driven by a shared clock so tests are deterministic. */
class FakeRedis implements BreakerRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number) {}

  async set(key: string, value: string, _mode: 'PX', ttlMs: number): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
    return 'OK';
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    const now = this.now();
    return keys.map((k) => {
      const e = this.store.get(k);
      if (!e) return null;
      if (e.expiresAt <= now) {
        this.store.delete(k);
        return null;
      }
      return e.value;
    });
  }
}

describe('RedisBreakerSync', () => {
  it('write-throughs an ejection and a peer reads it after refresh', async () => {
    const c = clock();
    const backing = new FakeRedis(c.now);
    // Two replicas over one Redis; distinct in-process snapshots.
    const a = new RedisBreakerSync(backing, { now: c.now });
    const b = new RedisBreakerSync(backing, { now: c.now });

    a.publishOpen('anthropic', 30_000);
    expect(a.sharedOpenUntil('anthropic')).toBe(30_000); // own publish is instant

    // Peer B must register interest then refresh to observe it.
    expect(b.sharedOpenUntil('anthropic')).toBe(0);
    await b.refresh();
    expect(b.sharedOpenUntil('anthropic')).toBe(30_000);
  });

  it('drops expired entries from the snapshot on refresh (self-heal via TTL)', async () => {
    const c = clock();
    const backing = new FakeRedis(c.now);
    const a = new RedisBreakerSync(backing, { now: c.now });
    const b = new RedisBreakerSync(backing, { now: c.now });

    a.publishOpen('openai', 1000);
    expect(b.sharedOpenUntil('openai')).toBe(0); // registers interest, nothing yet
    await b.refresh();
    expect(b.sharedOpenUntil('openai')).toBe(1000);

    c.advance(1001); // TTL elapsed
    await b.refresh();
    expect(b.sharedOpenUntil('openai')).toBe(0);
  });

  it('never publishes a non-positive TTL', async () => {
    const c = clock();
    const backing = new FakeRedis(c.now);
    const a = new RedisBreakerSync(backing, { now: c.now });
    a.publishOpen('x', 0); // already expired
    const b = new RedisBreakerSync(backing, { now: c.now });
    await b.refresh(); // b hasn't registered 'x'; nothing to read
    expect(b.sharedOpenUntil('x')).toBe(0);
  });

  it('degrades to a stale-but-safe snapshot when Redis errors', async () => {
    const c = clock();
    const broken: BreakerRedis = {
      set: () => Promise.reject(new Error('down')),
      mget: () => Promise.reject(new Error('down')),
    };
    const s = new RedisBreakerSync(broken, { now: c.now });
    s.publishOpen('t', 5000); // swallowed write; local snapshot still updated
    expect(s.sharedOpenUntil('t')).toBe(5000);
    await expect(s.refresh()).resolves.toBeUndefined(); // error swallowed
    expect(s.sharedOpenUntil('t')).toBe(5000); // last snapshot preserved
  });
});
