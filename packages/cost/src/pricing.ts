/**
 * Seed pricing table — first-party Anthropic API list rates, USD per **million**
 * tokens, as of 2026-08-12.
 *
 * Pricing drifts. This table is a maintained seed, not a source of truth: a
 * later milestone lets an operator override rates via config, and the model
 * catalog is fetched live from `GET /v1/models` (which does NOT return pricing,
 * so this table stays the pricing authority). Unknown models meter tokens but
 * report `priced: false` rather than guessing a rate.
 */
export interface ModelRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export const PRICING_AS_OF = '2026-08-12';

export const ANTHROPIC_PRICING: Readonly<Record<string, ModelRate>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** Cache pricing is expressed as multipliers on the base input rate. */
export const CACHE_MULTIPLIERS = {
  /** Reading a cache hit. */
  read: 0.1,
  /** Writing a 5-minute-TTL cache entry. */
  write5m: 1.25,
  /** Writing a 1-hour-TTL cache entry. */
  write1h: 2.0,
} as const;

/**
 * Bedrock exposes Claude via region-prefixed inference-profile IDs
 * (`us.anthropic.claude-...`). Strip provider/region prefixes so the same
 * pricing table serves native Anthropic and Bedrock routes.
 */
export function normalizeModelId(model: string): string {
  return model.replace(/^(us|eu|apac|global)\./, '').replace(/^anthropic\./, '');
}

export function lookupRate(model: string): ModelRate | undefined {
  return ANTHROPIC_PRICING[normalizeModelId(model)];
}
