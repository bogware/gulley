import { readFileSync, writeFileSync } from 'node:fs';
import { type CatalogEntry, ModelCatalog } from './catalog';

/** Read an operator-maintained catalog file (a JSON array of CatalogEntry). */
export function loadCatalogEntries(path: string): CatalogEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`catalog file ${path} is not a JSON array`);
  return parsed as CatalogEntry[];
}

export function loadCatalogFromFile(path: string): ModelCatalog {
  return new ModelCatalog(loadCatalogEntries(path));
}

/** Write catalog entries (e.g. from a models.dev refresh) to a file the gateway
 *  loads on boot — the manual-refresh persistence point. */
export function writeCatalogFile(path: string, entries: CatalogEntry[]): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}
