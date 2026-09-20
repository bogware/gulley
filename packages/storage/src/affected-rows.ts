/**
 * Rows touched by a Drizzle write, portable across drivers: postgres-js returns an
 * Array subclass carrying `.count` (NO rowCount), while node-postgres / PGlite expose
 * `.rowCount`. Every sweep/CAS in this package must read through here — reading
 * `.rowCount` alone reports 0 in production on postgres-js (sweeps looked idle).
 */
export function affectedRows(res: unknown): number {
  const r = res as { rowCount?: number; count?: number } | undefined;
  return r?.rowCount ?? r?.count ?? 0;
}
