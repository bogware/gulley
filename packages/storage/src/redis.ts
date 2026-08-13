import { Redis } from 'ioredis';

export type RedisRole = 'cache' | 'counters' | 'vector';

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
export function createRedisClient(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableAutoPipelining: true });
}

export function createRedisClients(urls: RedisUrls): RedisClients {
  return {
    cache: createRedisClient(urls.cache),
    counters: createRedisClient(urls.counters),
    vector: createRedisClient(urls.vector),
  };
}
