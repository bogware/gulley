/**
 * Seed pricing tables — provider list rates, USD per **million** tokens, as of
 * 2026-08-12. Pricing drifts; these are maintained seeds, not a source of truth
 * (a later milestone lets an operator override rates via config). Unknown
 * models meter tokens but report `priced: false` rather than guessing.
 */
export interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export const PRICING_AS_OF = '2026-08-12';

// --- Anthropic (first-party API list rates) ---
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelRate>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
  // Older Claude generations still served on Bedrock:
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

// --- OpenAI (verify against current pricing; seeded with well-known rates) ---
export const OPENAI_PRICING: Readonly<Record<string, ModelRate>> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
};

export const CACHE_MULTIPLIERS = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
} as const;

/** Strip Bedrock region/provider prefixes and a trailing `-YYYYMMDD` snapshot
 *  (the Messages API reports the dated id; pricing is keyed by the alias). The
 *  8-digit guard leaves minor versions like `claude-opus-4-8` untouched. */
export function normalizeModelId(model: string): string {
  return model
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}$/, '');
}

/** OpenAI reports dated snapshots as `-YYYY-MM-DD`; pricing is keyed by alias. */
function normalizeOpenAIModel(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** Bedrock ids look like `us.anthropic.claude-3-5-haiku-20241022-v1:0`; strip
 *  the region/provider prefix, the `-vN:M` suffix, and the date snapshot. */
function normalizeBedrockModel(model: string): string {
  return model
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-\d{8}$/, '');
}

export function lookupRate(model: string): ModelRate | undefined {
  return ANTHROPIC_PRICING[normalizeModelId(model)];
}

export interface ProviderPricing {
  rates: Readonly<Record<string, ModelRate>>;
  /** Cache pricing as multipliers on the base input rate. */
  cache: { read: number; write5m: number; write1h: number };
  normalize: (model: string) => string;
}

export const PROVIDER_PRICING: Readonly<Record<string, ProviderPricing>> = {
  anthropic: {
    rates: ANTHROPIC_PRICING,
    cache: {
      read: CACHE_MULTIPLIERS.read,
      write5m: CACHE_MULTIPLIERS.write5m,
      write1h: CACHE_MULTIPLIERS.write1h,
    },
    normalize: normalizeModelId,
  },
  openai: {
    // OpenAI has no separate cache-write charge; cached input is ~0.5x.
    rates: OPENAI_PRICING,
    cache: { read: 0.5, write5m: 1.0, write1h: 1.0 },
    normalize: normalizeOpenAIModel,
  },
  bedrock: {
    // Claude on Bedrock — reuse the Anthropic rate table as a seed (Bedrock
    // partner pricing is close but not identical; verify for billing use).
    rates: ANTHROPIC_PRICING,
    cache: {
      read: CACHE_MULTIPLIERS.read,
      write5m: CACHE_MULTIPLIERS.write5m,
      write1h: CACHE_MULTIPLIERS.write1h,
    },
    normalize: normalizeBedrockModel,
  },
};
