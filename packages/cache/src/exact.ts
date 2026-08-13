import type { CachedResponse, ExactCacheStore } from './types';

interface Slot {
  value: CachedResponse;
  expiresAtMs: number;
}

/**
 * In-memory exact cache with per-entry TTL. Used for CI/tests and single-node
 * dev; Postgres and Redis stores (in @gulley/storage) back multi-node prod.
 * `now` is injectable so expiry is testable without wall-clock waits.
 */
export class InMemoryExactCache implements ExactCacheStore {
  private readonly map = new Map<string, Slot>();

  constructor(private readonly now: () => number = () => Date.now()) {}

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
    this.map.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }

  get size(): number {
    return this.map.size;
  }
}
