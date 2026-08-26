import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ListenConnection } from './db';

/**
 * The cross-replica config-propagation bus. A config change is committed to
 * Postgres (the durable source of truth), then a tiny SIGNAL — never the config
 * body, never a secret — is fanned out so every gateway replica knows to re-read.
 * Two transports carry it: Postgres LISTEN/NOTIFY (anchored to the durable write,
 * with free reconnect catch-up) and Redis pub/sub (fast fan-out). Delivery is
 * best-effort/at-most-once; correctness comes from the monotonic version, not the
 * bus — a subscriber re-reads Postgres and ignores anything it has already seen.
 */
export interface ConfigSignal {
  /** Monotonic config version — the idempotency + ordering token. */
  v: number;
  /** Content hash of the committed document (for observability / drift). */
  hash: string;
  /** Emitting process's origin id — lets a process ignore its own writes. */
  origin: string;
  /** Emit timestamp (ms). */
  ts: number;
}

export interface ConfigNotifier {
  emit(sig: ConfigSignal): Promise<void>;
}

export interface ConfigSubscriber {
  /** Register the reload callback. Only de-duplicated, non-self signals arrive. */
  onSignal(cb: (sig: ConfigSignal) => void): void;
  /** Begin receiving (opens the underlying connection/subscription). */
  start(): Promise<void>;
  /** Stop and release the underlying connection. */
  close(): Promise<void>;
}

/** A fresh per-process origin id, minted once at boot. */
export function newOriginId(): string {
  return randomUUID();
}

export const DEFAULT_CONFIG_CHANNEL = 'gulley:config';

/**
 * Drops signals a subscriber should not act on: its own emissions (origin match)
 * and anything at or below the highest version already applied (dedupes the dual
 * bus and any replay/out-of-order delivery). Monotonic and idempotent.
 */
export class SignalGate {
  private applied: number;
  constructor(
    private readonly ownOrigin: string,
    initialVersion = 0,
  ) {
    this.applied = initialVersion;
  }
  /** True if this signal is new and foreign — and, if so, advances the cursor. */
  accept(sig: ConfigSignal): boolean {
    if (sig.origin === this.ownOrigin) return false;
    if (sig.v <= this.applied) return false;
    this.applied = sig.v;
    return true;
  }
  /** Advance the cursor from a durable read (e.g. reconnect catch-up). */
  observe(version: number): void {
    if (version > this.applied) this.applied = version;
  }
  get appliedVersion(): number {
    return this.applied;
  }
}

/** Parse a signal off the wire; returns undefined for anything malformed. */
export function parseSignal(payload: string): ConfigSignal | undefined {
  try {
    const o = JSON.parse(payload) as Partial<ConfigSignal>;
    if (typeof o.v === 'number' && typeof o.hash === 'string' && typeof o.origin === 'string') {
      return { v: o.v, hash: o.hash, origin: o.origin, ts: typeof o.ts === 'number' ? o.ts : 0 };
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Fan one emit out to several transports; a failing transport never blocks the
 *  others (the durable write already happened — the bus is best-effort). */
export class CompositeConfigNotifier implements ConfigNotifier {
  constructor(private readonly notifiers: ConfigNotifier[]) {}
  async emit(sig: ConfigSignal): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.emit(sig)));
  }
}

/** In-process bus (single-process deployments + tests): emit invokes every local
 *  subscriber synchronously. Implements both ports over a shared hub. */
export class InMemoryConfigBus implements ConfigNotifier, ConfigSubscriber {
  private readonly listeners = new Set<(sig: ConfigSignal) => void>();
  emit(sig: ConfigSignal): Promise<void> {
    for (const cb of this.listeners) cb(sig);
    return Promise.resolve();
  }
  onSignal(cb: (sig: ConfigSignal) => void): void {
    this.listeners.add(cb);
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}

/** Postgres LISTEN/NOTIFY transport over a dedicated listen connection. */
export class PostgresConfigBus implements ConfigNotifier, ConfigSubscriber {
  private cb: ((sig: ConfigSignal) => void) | undefined;
  constructor(
    private readonly sql: ListenConnection,
    private readonly channel: string = DEFAULT_CONFIG_CHANNEL,
    /** Invoked on every (re)connect — the seam for version-gated catch-up, since
     *  LISTEN silently drops events while the socket is down. */
    private readonly onListen?: () => void,
  ) {}
  async emit(sig: ConfigSignal): Promise<void> {
    await this.sql.notify(this.channel, JSON.stringify(sig));
  }
  onSignal(cb: (sig: ConfigSignal) => void): void {
    this.cb = cb;
  }
  async start(): Promise<void> {
    await this.sql.listen(
      this.channel,
      (payload: string) => {
        const sig = parseSignal(payload);
        if (sig && this.cb) this.cb(sig);
      },
      this.onListen,
    );
  }
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** Redis pub/sub transport. The subscriber MUST be a dedicated connection —
 *  ioredis subscribe mode disables ordinary commands on that socket, so it can
 *  never be the counters client that runs budget/rate-limit INCR. */
export class RedisConfigBus implements ConfigNotifier, ConfigSubscriber {
  private cb: ((sig: ConfigSignal) => void) | undefined;
  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly channel: string = DEFAULT_CONFIG_CHANNEL,
  ) {}
  async emit(sig: ConfigSignal): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(sig));
  }
  onSignal(cb: (sig: ConfigSignal) => void): void {
    this.cb = cb;
  }
  async start(): Promise<void> {
    this.subscriber.on('message', (_channel: string, payload: string) => {
      const sig = parseSignal(payload);
      if (sig && this.cb) this.cb(sig);
    });
    await this.subscriber.subscribe(this.channel);
  }
  async close(): Promise<void> {
    await this.subscriber.unsubscribe(this.channel).catch(() => {});
    this.subscriber.disconnect();
  }
}
