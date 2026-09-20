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
export interface RedisClientOptions {
  /** Which role this client serves — selects the command-timeout default and labels
   *  the connection-error log line. */
  role?: RedisRole;
  onError?: RedisErrorLogger;
  /** Per-command deadline (ms). A connected-but-silent server (AOF fsync stall, swap,
   *  a half-open socket after a failover) otherwise parks every budget/rate-limit EVAL
   *  forever — `maxRetriesPerRequest` only counts reconnects, so nothing rejects and
   *  the fail-open/closed policy never runs. Queued (offline) commands are covered too. */
  commandTimeoutMs?: number;
  /** TCP connect deadline (ms); ioredis defaults to 10 s per attempt. */
  connectTimeoutMs?: number;
}

/** Default per-command deadlines by role: the counters store gates admission on the
 *  hot path (tight); the cache is bounded again by the lookup timeout above it; vector
 *  queries are the heaviest. */
const DEFAULT_COMMAND_TIMEOUT_MS: Record<RedisRole, number> = {
  counters: 2_000,
  cache: 1_500,
  vector: 3_000,
};
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export function createRedisClient(
  url: string,
  onErrorOrOpts?: RedisErrorLogger | RedisClientOptions,
): Redis {
  const opts: RedisClientOptions =
    typeof onErrorOrOpts === 'function' ? { onError: onErrorOrOpts } : (onErrorOrOpts ?? {});
  const role = opts.role;
  const onError = opts.onError;
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    commandTimeout: opts.commandTimeoutMs ?? (role ? DEFAULT_COMMAND_TIMEOUT_MS[role] : 2_000),
    connectTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    // Managed-Redis failover (ElastiCache/MemoryDB promotes a replica and flips the
    // primary endpoint's DNS) leaves ioredis holding a socket to the DEMOTED node,
    // which answers every write with READONLY until that socket happens to drop. For
    // the counters role that is a fleet-wide fail-open storm. Reconnect (and resend the
    // failed command) on READONLY, per the AWS guidance.
    reconnectOnError: (err) => (err.message.startsWith('READONLY') ? 2 : false),
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
    else console.warn(`[redis${role ? `:${role}` : ''}] connection error: ${err.message}`);
  });
  return client;
}

export function createRedisClients(urls: RedisUrls, onError?: RedisErrorLogger): RedisClients {
  return {
    cache: createRedisClient(urls.cache, { role: 'cache', onError }),
    counters: createRedisClient(urls.counters, { role: 'counters', onError }),
    vector: createRedisClient(urls.vector, { role: 'vector', onError }),
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
