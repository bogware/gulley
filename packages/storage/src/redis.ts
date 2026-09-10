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

/**
 * Best-effort boot check that a role's Redis honors the eviction policy its data
 * needs: `counters` and `vector` MUST be `noeviction` (evicting a budget/rate-limit
 * counter silently under-charges and bypasses the cap; evicting a vector silently
 * degrades recall). Pointing one of those URLs at an `allkeys-lru` instance — an easy
 * self-host mistake when sharing one Redis for all three roles — otherwise corrupts
 * spend enforcement with NO error anywhere. Logs a loud warning on a wrong (or
 * unverifiable) policy rather than failing readiness: managed Redis (ElastiCache and
 * others) frequently disable/rename CONFIG, and a correctly-configured deployment
 * must not be taken out of service just because CONFIG GET is unavailable.
 */
export async function checkEvictionPolicy(
  client: Redis,
  role: RedisRole,
  log: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  const required = role === 'cache' ? 'allkeys-lru' : 'noeviction';
  let policy: string | undefined;
  try {
    const res = (await client.call('CONFIG', 'GET', 'maxmemory-policy')) as unknown;
    if (Array.isArray(res) && typeof res[1] === 'string') policy = res[1];
  } catch (err) {
    log.warn(
      { role, err: (err as Error).message },
      `redis[${role}]: could not verify maxmemory-policy is '${required}' (CONFIG denied/unavailable)`,
    );
    return;
  }
  if (!policy) {
    log.warn(
      { role },
      `redis[${role}]: could not read maxmemory-policy (CONFIG unavailable); expected '${required}'`,
    );
    return;
  }
  if (role !== 'cache' && policy !== 'noeviction') {
    log.warn(
      { role, policy, required: 'noeviction' },
      `redis[${role}]: maxmemory-policy is '${policy}' but MUST be 'noeviction' — budget/rate-limit counters (or semantic vectors) can be silently evicted under memory pressure, bypassing spend enforcement`,
    );
  } else if (role === 'cache' && policy === 'noeviction') {
    log.warn(
      { role, policy },
      `redis[cache]: maxmemory-policy is 'noeviction'; 'allkeys-lru' is expected so the cache can shed entries under memory pressure instead of erroring`,
    );
  }
}
