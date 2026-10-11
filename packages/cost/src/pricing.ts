/**
 * Seed pricing tables — provider list rates, USD per **million** tokens, as of
 * 2026-10-10 (Anthropic from the Claude API model reference dated 2026-10-06, OpenAI
 * from the public pricing page). Pricing drifts; these are maintained seeds, not a
 * source of truth — the models.dev catalog (`MODELS_CATALOG_FILE`) overrides them.
 * Unknown models meter tokens but report `priced: false` rather than guessing.
 */
export interface CacheMultipliers {
  /** Cached-input (cache read) price as a multiple of the base input rate. */
  read: number;
  /** 5-minute-TTL cache write as a multiple of the base input rate. */
  write5m: number;
  /** 1-hour-TTL cache write as a multiple of the base input rate. */
  write1h: number;
}

export interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Per-model cache multipliers; absent fields fall back to the provider default. A
   *  flat provider-wide multiplier mis-priced the current generation (Opus 5.5 reads at
   *  0.05×, Fable 5.1 at 0.025×, OpenAI's older families at 0.25×–0.5×). */
  cache?: Partial<CacheMultipliers>;
  /** Long-context tier: when a request's total input tokens exceed `aboveInputTokens`
   *  the WHOLE request is billed at the tier rates (how Anthropic and OpenAI bill it). */
  tier?: { aboveInputTokens: number; input: number; output: number };
}

export const PRICING_AS_OF = '2026-10-10';

// --- Anthropic (first-party API list rates) ---
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelRate>> = {
  // Fable / Mythos tier: cache reads 0.025× on 5.1 ($0.25/MTok), 0.1× on 5 ($1/MTok).
  'claude-fable-5-1': { input: 10, output: 50, cache: { read: 0.025 } },
  'claude-mythos-5-1': { input: 10, output: 50, cache: { read: 0.025 } },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  // Opus: 5.5 is cheaper than 5 and reads cache at 0.05× ($0.20/MTok).
  'claude-opus-5-5': { input: 4, output: 20, cache: { read: 0.05 } },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  // Sonnet: 5 and 5.5 list at $2/$10 (the 4.6 generation was $3/$15).
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Haiku 5.5 has a long-prompt tier above 100K input tokens.
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    tier: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Older Claude generations still served on Bedrock:
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
};

// --- OpenAI (public pricing page, 2026-10-10). Cached input is 0.1× on the GPT-5
// generation; older families carry their own multiplier. "Long" = input > 272K tokens.
const LONG = 272_000;
export const OPENAI_PRICING: Readonly<Record<string, ModelRate>> = {
  // gpt-5.6 (sol is a promotional rate through at least 2026-11-21)
  'gpt-5.6-sol': { input: 4, output: 20, tier: { aboveInputTokens: LONG, input: 8, output: 30 } },
  'gpt-5.6-terra': {
    input: 2,
    output: 12,
    tier: { aboveInputTokens: LONG, input: 4, output: 18 },
  },
  'gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    tier: { aboveInputTokens: LONG, input: 0.4, output: 1.8 },
  },
  'gpt-5.5': { input: 5, output: 30, tier: { aboveInputTokens: LONG, input: 10, output: 45 } },
  'gpt-5.5-pro': {
    input: 30,
    output: 180,
    cache: { read: 1 },
    tier: { aboveInputTokens: LONG, input: 60, output: 270 },
  },
  'gpt-5.4': { input: 2.5, output: 15, tier: { aboveInputTokens: LONG, input: 5, output: 22.5 } },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4-pro': {
    input: 30,
    output: 180,
    cache: { read: 1 },
    tier: { aboveInputTokens: LONG, input: 60, output: 270 },
  },
  'gpt-5.2': { input: 1.75, output: 14 },
  'gpt-5.2-pro': { input: 21, output: 168, cache: { read: 1 } },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-pro': { input: 15, output: 120, cache: { read: 1 } },
  // gpt-4.1 family: cached input 0.25×
  'gpt-4.1': { input: 2, output: 8, cache: { read: 0.25 } },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cache: { read: 0.25 } },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cache: { read: 0.25 } },
  // gpt-4o family: cached input 0.5×
  'gpt-4o': { input: 2.5, output: 10, cache: { read: 0.5 } },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache: { read: 0.5 } },
  // o-series
  o1: { input: 15, output: 60, cache: { read: 0.5 } },
  'o1-pro': { input: 150, output: 600, cache: { read: 1 } },
  o3: { input: 2, output: 8, cache: { read: 0.25 } },
  'o3-pro': { input: 20, output: 80, cache: { read: 1 } },
  'o3-mini': { input: 1.1, output: 4.4, cache: { read: 0.5 } },
  'o4-mini': { input: 1.1, output: 4.4, cache: { read: 0.25 } },
  // Embeddings bill input only (the /v1/embeddings route metered $0 without these).
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },
};

// --- Google Gemini / Vertex (flat per-model seeds; context-length tiers are a
// separate follow-on, and the models.dev catalog resolver overrides these). ---
export const GEMINI_PRICING: Readonly<Record<string, ModelRate>> = {
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
};

/** Anthropic's default cache multipliers (per-model `cache` entries override `read`). */
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

/** Gemini/Vertex model ids may carry a `models/` or `publishers/google/models/`
 *  prefix and a `-latest` or `-NNN` snapshot suffix; pricing is keyed by alias. */
function normalizeGeminiModel(model: string): string {
  return model
    .replace(/^publishers\/google\/models\//, '')
    .replace(/^models\//, '')
    .replace(/-latest$/, '')
    .replace(/-\d{3,}$/, '');
}

export function lookupRate(model: string): ModelRate | undefined {
  return ANTHROPIC_PRICING[normalizeModelId(model)];
}

export interface ProviderPricing {
  rates: Readonly<Record<string, ModelRate>>;
  /** Provider-default cache pricing as multipliers on the base input rate; a model's
   *  own `cache` entry overrides individual fields. */
  cache: CacheMultipliers;
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
    // OpenAI has no separate cache-write charge; cached input is 0.1× on the GPT-5
    // generation (older families override per model above).
    rates: OPENAI_PRICING,
    cache: { read: 0.1, write5m: 1.0, write1h: 1.0 },
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
  azure: {
    // Azure OpenAI bills at OpenAI rates (deployment name is the model).
    rates: OPENAI_PRICING,
    cache: { read: 0.1, write5m: 1.0, write1h: 1.0 },
    normalize: normalizeOpenAIModel,
  },
  gemini: {
    // Gemini context caching bills cached input at ~0.25x; no separate write charge.
    rates: GEMINI_PRICING,
    cache: { read: 0.25, write5m: 1.0, write1h: 1.0 },
    normalize: normalizeGeminiModel,
  },
  vertex: {
    // Gemini-on-Vertex uses the same rates (Claude-on-Vertex would fall through to
    // the unknown floor until seeded — safe, never $0).
    rates: GEMINI_PRICING,
    cache: { read: 0.25, write5m: 1.0, write1h: 1.0 },
    normalize: normalizeGeminiModel,
  },
};

/** Resolve the effective rates for a request: the model's long-context tier when the
 *  request's total input exceeds its threshold, else the base rate. */
export function effectiveRate(
  rate: ModelRate,
  totalInputTokens: number,
): { input: number; output: number } {
  const tier = rate.tier;
  if (tier && totalInputTokens > tier.aboveInputTokens)
    return { input: tier.input, output: tier.output };
  return { input: rate.input, output: rate.output };
}
