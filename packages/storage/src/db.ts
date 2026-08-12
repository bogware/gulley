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
