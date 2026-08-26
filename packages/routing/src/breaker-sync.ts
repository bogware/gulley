/**
 * Cross-replica breaker sharing.
 *
 * The {@link CircuitBreaker} learns upstream health per-replica: in a multi-task
 * deployment each replica must independently fail N times before it ejects a down
 * provider, so an outage costs `N × replicas` wasted calls instead of `N`. A
 * `BreakerSync` lets a replica that has ejected a target broadcast that ejection
 * so its peers honor it too — the first replica to notice protects the fleet.
 *
 * The contract is deliberately narrow and synchronous on the read path (it is
 * consulted in the hot failover loop): `sharedOpenUntil` reads a locally-cached
 * snapshot, and `publishOpen` is fire-and-forget. Shared state is advisory
 * DOWNWARD pressure only — it can eject a target the local breaker hasn't tripped,
 * but it never overrides a local half-open probe's own success, and it self-heals
 * via the entry's TTL (there is no explicit "close"): the broadcast simply says
 * "at least one replica saw this target down until T (epoch ms)".
 */
export interface BreakerSync {
  /** Broadcast that `key` is ejected until `openUntil` (epoch ms). Never throws. */
  publishOpen(key: string, openUntil: number): void;
  /** Shared open-until (epoch ms) for `key` from the last refresh; 0 if healthy. */
  sharedOpenUntil(key: string): number;
}

/** Default: no sharing (single-replica / in-memory deployments). */
export class NoopBreakerSync implements BreakerSync {
  publishOpen(): void {}
  sharedOpenUntil(): number {
    return 0;
  }
}

/** Minimal Redis surface (ioredis satisfies this) so this package needn't depend
 *  on ioredis directly — the same seam the budget/ratelimit Redis stores use. */
export interface BreakerRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export interface RedisBreakerSyncOptions {
  /** Key namespace, so distinct deployments on one Redis don't collide. */
  prefix?: string;
  /** How often to refresh the local snapshot from Redis (ms). */
  refreshMs?: number;
  now?: () => number;
}

/**
 * Cross-replica {@link BreakerSync} over the `counters` Redis (the `noeviction`
 * instance — a dropped ejection would silently un-protect a down upstream, so it
 * must never be evicted). Each replica WRITES its own ejections through with a TTL
 * equal to the remaining open window (the entry self-heals when the window ends,
 * so there is no explicit close), and READS peers' ejections from a locally-cached
 * snapshot refreshed on a timer. The read path ({@link sharedOpenUntil}) is
 * therefore synchronous and cheap — it is consulted in the hot failover loop.
 *
 * All Redis I/O is best-effort: any error degrades to per-replica behavior (the
 * local breaker still works), never to a worse-than-baseline state. Call
 * {@link start} to begin refreshing and {@link stop} on drain.
 */
export class RedisBreakerSync implements BreakerSync {
  private readonly prefix: string;
  private readonly refreshMs: number;
  private readonly now: () => number;
  /** Target keys we have observed (published or queried), so refresh knows what
   *  to MGET. Bounded by the number of route targets. */
  private readonly known = new Set<string>();
  /** Local snapshot: key → shared openUntil (epoch ms). */
  private snapshot = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly redis: BreakerRedis,
    opts: RedisBreakerSyncOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'gulley';
    this.refreshMs = opts.refreshMs ?? 1000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  private redisKey(key: string): string {
    return `${this.prefix}:breaker:${key}`;
  }

  publishOpen(key: string, openUntil: number): void {
    this.known.add(key);
    // Honor our own ejection instantly, before the next refresh tick.
    this.snapshot.set(key, openUntil);
    const ttl = openUntil - this.now();
    if (ttl <= 0) return;
    // Fire-and-forget; a write failure just means peers learn on their own.
    void Promise.resolve(
      this.redis.set(this.redisKey(key), String(openUntil), 'PX', Math.ceil(ttl)),
    ).catch(() => {});
  }

  sharedOpenUntil(key: string): number {
    this.known.add(key);
    return this.snapshot.get(key) ?? 0;
  }

  /** One refresh pass: MGET every known key into a fresh snapshot. */
  async refresh(): Promise<void> {
    const keys = [...this.known];
    if (keys.length === 0) return;
    let values: (string | null)[];
    try {
      values = await this.redis.mget(...keys.map((k) => this.redisKey(k)));
    } catch {
      return; // keep the last snapshot; degrade to stale-but-safe
    }
    const now = this.now();
    const next = new Map<string, number>();
    keys.forEach((k, i) => {
      const raw = values[i];
      const until = raw ? Number(raw) : 0;
      // Drop entries that have already expired so the snapshot stays small.
      if (Number.isFinite(until) && until > now) next.set(k, until);
    });
    this.snapshot = next;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    // Don't keep the event loop alive on account of the refresh timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
