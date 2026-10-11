import { CACHE_MULTIPLIERS } from '@gulley/cost';
import type { CatalogEntry } from './catalog';

/**
 * Map the RAW models.dev `api.json` payload into catalog entries. The payload is
 * keyed by provider id (`anthropic`, `openai`, `amazon-bedrock`, ...), each with a
 * `models` map; each model carries a `cost` (USD per 1M tokens: input/output,
 * optional cache_read/cache_write, optional long-context `tiers`) and a `limit`
 * (`context`, `output`). models.dev provider ids are aliased to Gulley's labels.
 * Top-level keys starting with `_` (the bundled snapshot's `_meta`) are ignored.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  google: 'gemini',
  'google-vertex': 'vertex',
  'amazon-bedrock': 'bedrock',
  bedrock: 'bedrock',
  'azure-openai': 'azure',
  togetherai: 'together',
  'x-ai': 'xai',
  'github-copilot': 'copilot',
};

/** Gulley's provider label for a models.dev provider id. */
export function aliasModelsDevProvider(providerId: string): string {
  return PROVIDER_ALIASES[providerId] ?? providerId;
}

interface ModelsDevTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type?: string; size?: number };
}
interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelsDevTier[];
}
interface ModelsDevModel {
  id?: string;
  name?: string;
  release_date?: string;
  cost?: ModelsDevCost | null;
  limit?: { context?: number; input?: number; output?: number };
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function rate(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}
function positiveInt(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The first `context`-type tier with usable prices, as a catalog tier. */
function tierOf(tiers: unknown): CatalogEntry['tier'] | undefined {
  if (!Array.isArray(tiers)) return undefined;
  for (const t of tiers as ModelsDevTier[]) {
    if (t?.tier?.type !== 'context') continue;
    const aboveInputTokens = positiveInt(t.tier.size);
    const input = rate(t.input);
    const output = rate(t.output);
    if (aboveInputTokens === undefined || input === undefined || output === undefined) continue;
    return { aboveInputTokens, input, output };
  }
  return undefined;
}

export function parseModelsDev(payload: unknown): CatalogEntry[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const out: CatalogEntry[] = [];
  for (const [providerId, prov] of Object.entries(payload as Record<string, ModelsDevProvider>)) {
    if (providerId.startsWith('_')) continue; // snapshot metadata, not a provider
    const provider = aliasModelsDevProvider(providerId);
    const models = prov?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, m] of Object.entries(models)) {
      const cost = m?.cost;
      if (!cost || typeof cost !== 'object') continue; // null cost → unpriced → skip
      const input = rate(cost.input);
      const output = rate(cost.output);
      if (input === undefined || output === undefined) continue; // unpriced → skip
      // input 0 + output 0 is a priced (free) model, not an unpriced one.
      const entry: CatalogEntry = { provider, model: modelId, input, output };
      // models.dev gives absolute cache USD/1M; convert to input-rate multipliers.
      const cacheRead = rate(cost.cache_read);
      const cacheWrite = rate(cost.cache_write);
      if (input > 0 && (cacheRead !== undefined || cacheWrite !== undefined)) {
        const read = cacheRead !== undefined ? cacheRead / input : 1;
        const write = cacheWrite !== undefined ? cacheWrite / input : 1;
        // models.dev publishes ONE cache-write price (the 5-minute tier). The 1-hour
        // tier is priced at a fixed ratio to it (Anthropic: 2.0x vs 1.25x the input
        // rate); copying the 5m figure into write1h under-billed 1h writes by 37.5%.
        const write1h =
          cacheWrite !== undefined
            ? write * (CACHE_MULTIPLIERS.write1h / CACHE_MULTIPLIERS.write5m)
            : write;
        entry.cache = { read, write5m: write, write1h };
      }
      const tier = tierOf(cost.tiers);
      if (tier) entry.tier = tier;
      const context = positiveInt(m.limit?.context);
      if (context !== undefined) entry.contextLength = context;
      const maxOutput = positiveInt(m.limit?.output);
      if (maxOutput !== undefined) entry.maxOutputTokens = maxOutput;
      const displayName = str(m.name);
      if (displayName !== undefined) entry.displayName = displayName;
      const releaseDate = str(m.release_date);
      if (releaseDate !== undefined) entry.releaseDate = releaseDate;
      out.push(entry);
    }
  }
  return out;
}

export interface FetchModelsDevOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetch + parse the models.dev catalog. Throws on any failure so the caller can
 *  keep its last-valid catalog (never replace with a partial/empty result). This is
 *  an explicit operator action (`catalog:refresh`, `snapshot`) — the gateway never
 *  calls it at runtime. */
export async function fetchModelsDev(opts: FetchModelsDevOptions = {}): Promise<CatalogEntry[]> {
  const url = opts.url ?? 'https://models.dev/api.json';
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await f(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
    const entries = parseModelsDev(await res.json());
    if (entries.length === 0) throw new Error('models.dev returned no priced models');
    return entries;
  } finally {
    clearTimeout(timer);
  }
}
