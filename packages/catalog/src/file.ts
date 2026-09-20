import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { type CatalogEntry, ModelCatalog } from './catalog';

const finiteRate = z.number().finite().nonnegative();

/** Shape of one operator-catalog row. Rates must be finite, non-negative numbers: a
 *  string or null price used to flow through unchecked, priced the model at NaN/$0
 *  (budget reservation silently skipped, ledger insert failing on every request) while
 *  still reporting `priced: true`. */
export const CatalogEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  input: finiteRate,
  output: finiteRate,
  cache: z.object({ read: finiteRate, write5m: finiteRate, write1h: finiteRate }).optional(),
  contextLength: z.number().int().positive().optional(),
});

/** Read an operator-maintained catalog file (a JSON array of CatalogEntry). Rejects
 *  the whole file on any malformed row, naming the row, so a typo fails boot
 *  (health-only) instead of silently un-pricing a model. */
export function loadCatalogEntries(path: string): CatalogEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`catalog file ${path} is not a JSON array`);
  return parsed.map((row, i) => {
    const r = CatalogEntrySchema.safeParse(row);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(
        `catalog file ${path} row ${i}: ${issue?.path.join('.') || '(row)'} ${issue?.message ?? 'invalid'}`,
      );
    }
    return r.data as CatalogEntry;
  });
}

export function loadCatalogFromFile(path: string): ModelCatalog {
  return new ModelCatalog(loadCatalogEntries(path));
}

/** Write catalog entries (e.g. from a models.dev refresh) to a file the gateway
 *  loads on boot — the manual-refresh persistence point. */
export function writeCatalogFile(path: string, entries: CatalogEntry[]): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}
