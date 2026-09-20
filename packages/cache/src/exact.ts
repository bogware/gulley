import type { CachedResponse, ExactCacheStore } from './types';

interface Slot {
  value: CachedResponse;
  expiresAtMs: number;
}

export interface InMemoryExactCacheOptions {
  /** Upper bound on live entries; the oldest-inserted entry is evicted past it.
   *  Default 10_000. The memory backend is selectable in production config, so it
   *  must be bounded like the Redis/Postgres tiers (which have TTL sweeps). */
  maxEntries?: number;
  now?: () => number;
}

/** Expired entries are purged opportunistically every this-many writes, so a
 *  write-only workload (keys never read again) cannot grow the map past the TTL. */
const SWEEP_EVERY_N_WRITES = 256;

/**
 * In-memory exact cache with per-entry TTL. Used for CI/tests and single-node
 * dev; Postgres and Redis stores (in @gulley/storage) back multi-node prod.
 * `now` is injectable so expiry is testable without wall-clock waits.
 */
export class InMemoryExactCache implements ExactCacheStore {
  private readonly map = new Map<string, Slot>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private writes = 0;

  constructor(nowOrOpts: (() => number) | InMemoryExactCacheOptions = {}) {
    const opts = typeof nowOrOpts === 'function' ? { now: nowOrOpts } : nowOrOpts;
    this.maxEntries = Math.max(1, opts.maxEntries ?? 10_000);
    this.now = opts.now ?? (() => Date.now());
  }

  async get(key: string): Promise<CachedResponse | null> {
    const slot = this.map.get(key);
    if (!slot) return null;
    if (slot.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return slot.value;
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    if (++this.writes % SWEEP_EVERY_N_WRITES === 0) this.sweep();
    this.map.delete(key); // re-insert so the entry moves to the "newest" end
    this.map.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop every expired entry now. Returns entries removed. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, s] of this.map) {
      if (s.expiresAtMs <= t) {
        this.map.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}
