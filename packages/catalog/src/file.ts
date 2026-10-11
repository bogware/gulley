import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { type CatalogEntry, ModelCatalog } from './catalog';
import { parseModelsDev } from './models-dev';

const finiteRate = z.number().finite().nonnegative();

/** Shape of one operator-catalog / override row. Rates must be finite, non-negative
 *  numbers: a string or null price used to flow through unchecked, priced the model at
 *  NaN/$0 (budget reservation silently skipped, ledger insert failing on every request)
 *  while still reporting `priced: true`. */
export const CatalogEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  input: finiteRate,
  output: finiteRate,
  cache: z.object({ read: finiteRate, write5m: finiteRate, write1h: finiteRate }).optional(),
  tier: z
    .object({
      aboveInputTokens: z.number().int().positive(),
      input: finiteRate,
      output: finiteRate,
    })
    .optional(),
  contextLength: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  displayName: z.string().min(1).optional(),
  releaseDate: z.string().min(1).optional(),
});

/** The two on-disk catalog shapes: a JSON array of `CatalogEntry` (what
 *  `writeCatalogFile` / `catalog:refresh` emit) or the raw models.dev `api.json`
 *  object (the bundled snapshot, or a verbatim download). */
export type CatalogShape = 'entries' | 'models-dev' | 'unknown';

export function detectCatalogShape(parsed: unknown): CatalogShape {
  if (Array.isArray(parsed)) return 'entries';
  if (!parsed || typeof parsed !== 'object') return 'unknown';
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // snapshot `_meta`
    if (value && typeof value === 'object' && 'models' in (value as object)) return 'models-dev';
  }
  return 'unknown';
}

/** Validate an array of catalog rows. Rejects the whole array on any malformed row,
 *  naming the row, so a typo fails loudly instead of silently un-pricing a model. */
function validateEntries(parsed: unknown, label: string): CatalogEntry[] {
  if (!Array.isArray(parsed)) throw new Error(`${label} is not a JSON array`);
  return parsed.map((row, i) => {
    const r = CatalogEntrySchema.safeParse(row);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new Error(
        `${label} row ${i}: ${issue?.path.join('.') || '(row)'} ${issue?.message ?? 'invalid'}`,
      );
    }
    return r.data as CatalogEntry;
  });
}

/** Parse operator pricing overrides (a JSON array of `CatalogEntry`, same schema as
 *  the catalog file). Throws naming the bad row. */
export function parsePricingOverrides(json: unknown): CatalogEntry[] {
  return validateEntries(json, 'pricing overrides');
}

/** Read a catalog file, auto-detecting its shape: a JSON array of CatalogEntry
 *  (validated row by row — a malformed row fails the whole file so a typo fails boot,
 *  health-only, instead of silently un-pricing a model) or a raw models.dev payload
 *  (mapped through `parseModelsDev`; it must yield at least one priced model). */
export function loadCatalogEntries(path: string): CatalogEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  switch (detectCatalogShape(parsed)) {
    case 'entries':
      return validateEntries(parsed, `catalog file ${path}`);
    case 'models-dev': {
      const entries = parseModelsDev(parsed);
      if (entries.length === 0)
        throw new Error(`catalog file ${path} (models.dev shape) has no priced models`);
      return entries;
    }
    default:
      throw new Error(
        `catalog file ${path} is not a JSON array of catalog entries or a models.dev payload`,
      );
  }
}

export function loadCatalogFromFile(path: string): ModelCatalog {
  return new ModelCatalog(loadCatalogEntries(path));
}

/** Reload `path` INTO an existing catalog (`replace`, so operator overrides survive).
 *  Throws on a read/parse failure, leaving the catalog untouched. Returns the count. */
export function reloadCatalogFile(path: string, catalog: ModelCatalog): number {
  return catalog.replace(loadCatalogEntries(path));
}

/** Write catalog entries (e.g. from a models.dev refresh) to a file the gateway
 *  loads on boot — the manual-refresh persistence point. */
export function writeCatalogFile(path: string, entries: CatalogEntry[]): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}
