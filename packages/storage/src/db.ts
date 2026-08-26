import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

/** Create a Drizzle client backed by postgres.js. Pool size is conservative;
 *  Aurora Serverless v2 sits behind RDS Proxy in prod. */
export function createDatabase(url: string, max = 10) {
  const client = postgres(url, { max });
  return drizzle(client, { schema });
}

/** Like `createDatabase`, but also returns a `close()` that ends the underlying
 *  pool — for a long-lived component (e.g. the config-reload watcher) that owns
 *  its own connection and must release it on shutdown. */
export function createClosableDatabase(
  url: string,
  max = 10,
): { db: Database; close: () => Promise<void> } {
  const client = postgres(url, { max });
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
