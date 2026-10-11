import type { RateOverride, RateResolver } from '@gulley/cost';

/**
 * A live model catalog: per-(provider, model) pricing that can be refreshed from
 * models.dev without a redeploy, layered over the in-tree seed rates. The
 * gateway consults it via a `RateResolver` in `computeCost`; an unknown model
 * falls through to the seed, then to priced:false. Per your manual-updates rule,
 * refresh is an explicit operator action (see `refreshFromModelsDev` / the
 * `catalog:refresh` script) that writes a file the gateway loads on boot (and may
 * poll, see `watchCatalogFile`). A bundled models.dev snapshot is the offline
 * fallback (`loadBundledSnapshot`); operator overrides layer on top of either.
 */
export interface CatalogEntry {
  provider: string;
  model: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Cache pricing as multipliers on the base input rate. */
  cache?: { read: number; write5m: number; write1h: number };
  /** Long-context tier: past `aboveInputTokens` total input tokens the WHOLE request
   *  bills at the tier rates (USD per million). */
  tier?: { aboveInputTokens: number; input: number; output: number };
  /** Context window (tokens), if known. */
  contextLength?: number;
  /** Maximum output tokens per response, if known. */
  maxOutputTokens?: number;
  /** Human-readable model name (models.dev `name`). */
  displayName?: string;
  /** Release date, `YYYY-MM-DD` (models.dev `release_date`). */
  releaseDate?: string;
}

/** Strip region/provider prefixes, `-vN:M` suffixes, and date snapshots so a
 *  dated/response model id matches its catalog alias. */
export function normalizeCatalogModel(model: string): string {
  return model
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

const keyOf = (provider: string, model: string): string =>
  `${provider}:${normalizeCatalogModel(model)}`;

/** The billing rate a catalog entry resolves to (what `computeCost` consumes). */
export function rateOf(e: CatalogEntry): RateOverride {
  return {
    input: e.input,
    output: e.output,
    ...(e.cache ? { cache: e.cache } : {}),
    ...(e.tier ? { tier: e.tier } : {}),
  };
}

const byModelId = (a: CatalogEntry, b: CatalogEntry): number =>
  a.model < b.model ? -1 : a.model > b.model ? 1 : 0;

interface Layer {
  rates: Map<string, RateOverride>;
  entries: Map<string, CatalogEntry>;
}

/** Index entries by normalized key. Several ids may collapse onto one key (Bedrock's
 *  `us.`/`eu.`/`global.` regional ids all normalize to the alias): the SHORTEST id wins
 *  so the listing shows the canonical alias and the outcome never depends on the
 *  source's key order. */
function index(entries: CatalogEntry[]): Layer {
  const rates = new Map<string, RateOverride>();
  const meta = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const key = keyOf(e.provider, e.model);
    const prev = meta.get(key);
    if (prev && prev.model.length <= e.model.length) continue;
    rates.set(key, rateOf(e));
    meta.set(key, e);
  }
  return { rates, entries: meta };
}

export class ModelCatalog {
  private catalog: Layer = index([]);
  private overrides: Layer = index([]);

  constructor(seed: CatalogEntry[] = []) {
    this.replace(seed);
  }

  /**
   * Atomically swap the whole catalog. "Keep-last-valid" is the caller's
   * contract: a failed refresh simply never calls this, so the previous
   * contents stay live. Operator overrides (`setOverrides`) are untouched.
   * Returns the entry count.
   */
  replace(entries: CatalogEntry[]): number {
    this.catalog = index(entries);
    return this.catalog.rates.size;
  }

  /**
   * Operator pricing overrides: consulted BEFORE the catalog on every lookup (a
   * negotiated Bedrock/Azure rate, a model models.dev does not list yet). They
   * survive `replace()` so a catalog reload never silently drops them. Pass `[]`
   * to clear. Returns the override count.
   */
  setOverrides(entries: CatalogEntry[]): number {
    this.overrides = index(entries);
    return this.overrides.rates.size;
  }

  lookup(provider: string, model: string): RateOverride | undefined {
    const key = keyOf(provider, model);
    return this.overrides.rates.get(key) ?? this.catalog.rates.get(key);
  }

  entry(provider: string, model: string): CatalogEntry | undefined {
    const key = keyOf(provider, model);
    return this.overrides.entries.get(key) ?? this.catalog.entries.get(key);
  }

  /** Catalog entry count (overrides excluded; see `overrideCount`). */
  get size(): number {
    return this.catalog.rates.size;
  }

  get overrideCount(): number {
    return this.overrides.rates.size;
  }

  /** The effective view: catalog entries with overrides layered on top (by key). */
  all(): CatalogEntry[] {
    return [...new Map([...this.catalog.entries, ...this.overrides.entries]).values()];
  }

  /** Effective entries for one provider label (e.g. `anthropic`, `bedrock`), sorted by
   *  model id — the shape a `/v1/models` listing wants. */
  entriesFor(provider: string): CatalogEntry[] {
    return this.all()
      .filter((e) => e.provider === provider)
      .sort(byModelId);
  }

  /** A resolver to pass to `computeCost`. */
  resolver(): RateResolver {
    return (provider, model) => this.lookup(provider, model);
  }
}
