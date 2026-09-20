import { CACHE_MULTIPLIERS } from '@gulley/cost';
import type { CatalogEntry } from './catalog';

/**
 * Map the models.dev `api.json` payload into catalog entries. The payload is
 * keyed by provider id, each with a `models` map; each model carries a `cost`
 * (USD per 1M tokens: input/output and optional cache_read/cache_write) and a
 * `limit.context`. models.dev provider ids are aliased to Gulley's labels.
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

interface ModelsDevModel {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number };
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseModelsDev(payload: unknown): CatalogEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const out: CatalogEntry[] = [];
  for (const [providerId, prov] of Object.entries(payload as Record<string, ModelsDevProvider>)) {
    const provider = PROVIDER_ALIASES[providerId] ?? providerId;
    const models = prov?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, m] of Object.entries(models)) {
      const input = num(m?.cost?.input);
      const output = num(m?.cost?.output);
      if (input === undefined || output === undefined) continue; // free/unpriced → skip
      const entry: CatalogEntry = { provider, model: modelId, input, output };
      // models.dev gives absolute cache USD/1M; convert to input-rate multipliers.
      const cacheRead = num(m?.cost?.cache_read);
      const cacheWrite = num(m?.cost?.cache_write);
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
      const context = num(m?.limit?.context);
      if (context !== undefined) entry.contextLength = context;
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
 *  keep its last-valid catalog (never replace with a partial/empty result). */
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
