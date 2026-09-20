/**
 * TTL memoization for an async resolver that sits on the request path (budget caps,
 * rate-limit rules). Keeps a Postgres blip from becoming a per-request admission
 * failure: within `ttlMs` the cached value is served; when the resolver THROWS, a
 * stale value up to `staleOnErrorMs` old is served instead (with the error passed to
 * `onError`). Bounded in size; a cold/expired entry after the stale window falls
 * through to the resolver (and its error) as before.
 */
export interface MemoizeOptions {
  /** Fresh window (ms). Default 10 s. */
  ttlMs?: number;
  /** How long a stale value may be served while the resolver is failing. Default 5 min. */
  staleOnErrorMs?: number;
  /** Max cached keys (oldest-inserted evicted). Default 10_000. */
  maxEntries?: number;
  onError?: (err: unknown, key: string) => void;
  now?: () => number;
}

export function memoizeAsync<V>(
  fn: (key: string) => Promise<V>,
  opts: MemoizeOptions = {},
): (key: string) => Promise<V> {
  const ttlMs = opts.ttlMs ?? 10_000;
  const staleMs = opts.staleOnErrorMs ?? 300_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { value: V; at: number }>();
  const inflight = new Map<string, Promise<V>>();
  return async (key) => {
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.at < ttlMs) return hit.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await fn(key);
        if (cache.size >= maxEntries && !cache.has(key)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { value, at: now() });
        return value;
      } catch (err) {
        opts.onError?.(err, key);
        if (hit && now() - hit.at < staleMs) return hit.value;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
