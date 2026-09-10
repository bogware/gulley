import { Redis } from 'ioredis';

export type RedisRole = 'cache' | 'counters' | 'vector';

/** Sink for connection-level Redis faults (defaults to stderr). Injectable so the
 *  gateway/control-api can route these into their structured logger. */
export type RedisErrorLogger = (err: Error) => void;

/** Throttle connection-error logging: a sustained outage re-emits 'error' on every
 *  reconnect attempt, so log at most once per this window per client to avoid spam. */
const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;

export interface RedisUrls {
  cache: string;
  counters: string;
  vector: string;
}

export type RedisClients = Record<RedisRole, Redis>;

/**
 * Role-split Redis clients. These are three physically distinct instances in
 * prod because their eviction policies conflict: cache is `allkeys-lru`, while
 * counters and the vector index must be `noeviction` (evicting a budget counter
 * silently under-charges; evicting vectors silently degrades recall).
 * See docs/ARCHITECTURE.md §13.
 */
export function createRedisClient(url: string, onError?: RedisErrorLogger): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
  });
  // CRITICAL: an ioredis client is an EventEmitter that THROWS on an 'error' event
  // with no listener — a connection-level fault (DNS/refused/reset/failover) would
  // otherwise become an uncaught exception that kills the process. The whole point
  // of the role-split cache tier is graceful degradation: a Redis blip must surface
  // as a per-command rejection (which the budget/cache/breaker stores already treat
  // as degradation), never as a data-plane crash. Log throttled so a sustained
  // outage's reconnect loop can't spam the log.
  let lastLoggedAt = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < REDIS_ERROR_LOG_INTERVAL_MS) return;
    lastLoggedAt = now;
    if (onError) onError(err);
    else console.warn(`[redis] connection error: ${err.message}`);
  });
  return client;
}

export function createRedisClients(urls: RedisUrls, onError?: RedisErrorLogger): RedisClients {
  return {
    cache: createRedisClient(urls.cache, onError),
    counters: createRedisClient(urls.counters, onError),
    vector: createRedisClient(urls.vector, onError),
  };
}
