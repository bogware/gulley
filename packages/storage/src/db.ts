import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

/** Pool + timeout options. All optional and OFF by default so the shared helper stays
 *  safe for callers that run genuinely long queries (control-api's full-chain audit
 *  scans / usage rollups); only the gateway data plane, whose queries are all short
 *  single-row lookups + best-effort sink writes, opts into the aggressive timeouts. */
export interface PoolOptions {
  /** Max pooled connections (postgres.js `max`). Default 10. */
  max?: number;
  /** Server-side per-statement cap (Postgres `statement_timeout`, ms). A hung query then
   *  REJECTS instead of pinning a connection — the missing fail-fast that otherwise lets a
   *  stuck sink write starve the authn pool. Undefined = no server-side cap (the default). */
  statementTimeoutMs?: number;
  /** Connection-acquisition timeout (postgres.js `connect_timeout`, ms). */
  connectTimeoutMs?: number;
  /** Close idle pooled connections after this long (postgres.js `idle_timeout`, ms) — keeps
   *  the pool lean behind RDS Proxy. */
  idleTimeoutMs?: number;
}

/** Back-compat: the old signature was `(url, max?)`. Accept a bare number as `max`. */
function normalize(opts?: PoolOptions | number): PoolOptions {
  return typeof opts === 'number' ? { max: opts } : (opts ?? {});
}

function pgOptions(opts: PoolOptions): postgres.Options<Record<string, never>> {
  const o: Record<string, unknown> = { max: opts.max ?? 10 };
  // postgres.js takes connect_timeout / idle_timeout in SECONDS.
  if (opts.connectTimeoutMs)
    o['connect_timeout'] = Math.max(1, Math.ceil(opts.connectTimeoutMs / 1000));
  if (opts.idleTimeoutMs) o['idle_timeout'] = Math.max(1, Math.ceil(opts.idleTimeoutMs / 1000));
  // statement_timeout is a server GUC applied per connection; Postgres reads a bare
  // integer as milliseconds. Set via the `connection` (session parameters) option.
  if (opts.statementTimeoutMs)
    o['connection'] = { statement_timeout: String(opts.statementTimeoutMs) };
  return o as postgres.Options<Record<string, never>>;
}

/** Create a Drizzle client backed by postgres.js. Pool size is conservative;
 *  Aurora Serverless v2 sits behind RDS Proxy in prod. Pass {@link PoolOptions} to
 *  bound query/connect/idle timeouts (the gateway hot path does — see context.ts). */
export function createDatabase(url: string, opts?: PoolOptions | number) {
  const client = postgres(url, pgOptions(normalize(opts)));
  return drizzle(client, { schema });
}

/** Like `createDatabase`, but also returns a `close()` that ends the underlying
 *  pool — for a long-lived component (e.g. the config-reload watcher) that owns
 *  its own connection and must release it on shutdown. */
export function createClosableDatabase(
  url: string,
  opts?: PoolOptions | number,
): { db: Database; close: () => Promise<void> } {
  const client = postgres(url, pgOptions(normalize(opts)));
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export type ListenConnection = ReturnType<typeof postgres>;

/**
 * A dedicated single-connection postgres.js handle for LISTEN/NOTIFY. Kept
 * separate from the query pool so the persistent listener socket never contends
 * with (or gets recycled by) the max:10 pool — and, behind RDS Proxy, so the
 * pinned listen session is explicit. Use `sql.listen(channel, cb, onListen)` to
 * receive and `sql.notify(channel, payload)` to send.
 */
export function createListenConnection(url: string): ListenConnection {
  return postgres(url, { max: 1 });
}
