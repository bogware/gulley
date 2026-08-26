import type { RateOverride, RateResolver } from '@gulley/cost';

/**
 * A live model catalog: per-(provider, model) pricing that can be refreshed from
 * models.dev without a redeploy, layered over the in-tree seed rates. The
 * gateway consults it via a `RateResolver` in `computeCost`; an unknown model
 * falls through to the seed, then to priced:false. Per your manual-updates rule,
 * refresh is an explicit operator action (see `refreshFromModelsDev` / the
 * `catalog:refresh` script) that writes a file the gateway loads on boot.
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
  /** Context window (tokens), if known. */
  contextLength?: number;
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

export class ModelCatalog {
  private rates = new Map<string, RateOverride>();
  private entries = new Map<string, CatalogEntry>();

  constructor(seed: CatalogEntry[] = []) {
    this.replace(seed);
  }

  /**
   * Atomically swap the whole catalog. "Keep-last-valid" is the caller's
   * contract: a failed refresh simply never calls this, so the previous
   * contents stay live. Returns the entry count.
   */
  replace(entries: CatalogEntry[]): number {
    const rates = new Map<string, RateOverride>();
    const meta = new Map<string, CatalogEntry>();
    for (const e of entries) {
      const key = `${e.provider}:${normalizeCatalogModel(e.model)}`;
      rates.set(key, { input: e.input, output: e.output, ...(e.cache ? { cache: e.cache } : {}) });
      meta.set(key, e);
    }
    this.rates = rates;
    this.entries = meta;
    return rates.size;
  }

  lookup(provider: string, model: string): RateOverride | undefined {
    return this.rates.get(`${provider}:${normalizeCatalogModel(model)}`);
  }

  entry(provider: string, model: string): CatalogEntry | undefined {
    return this.entries.get(`${provider}:${normalizeCatalogModel(model)}`);
  }

  get size(): number {
    return this.rates.size;
  }

  all(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  /** A resolver to pass to `computeCost`. */
  resolver(): RateResolver {
    return (provider, model) => this.lookup(provider, model);
  }
}
