import type { NormalizedUsage } from './normalized';
import { PROVIDER_PRICING } from './pricing';

/** A rate supplied by an external source (e.g. the models.dev catalog). Cache
 *  multipliers are optional; they fall back to the provider seed, then neutral. */
export interface RateOverride {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Cache pricing as multipliers on the base input rate. */
  cache?: { read: number; write5m: number; write1h: number };
}

/** Resolve a (provider, model) to a rate, or undefined to fall back to the seed. */
export type RateResolver = (provider: string, model: string) => RateOverride | undefined;

const NEUTRAL_CACHE = { read: 1, write5m: 1, write1h: 1 };

export interface CostBreakdown {
  provider: string;
  model: string;
  priced: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** input + cache_read + cache_write — the true billable input. */
  totalInputTokens: number;
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** Dollars saved by provider prompt caching on this request: what the cache_read
   *  tokens would have cost at the full input rate, minus what they cost at the
   *  discounted cache-read rate. 0 when unpriced or nothing was cache-read. */
  cacheSavedUsd: number;
}

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

/**
 * Price normalized usage against a provider's rate table. Always returns token
 * totals, so an unknown provider or model still meters usage (priced: false).
 */
/**
 * A relative price for ranking a (provider, model) in cost-aware routing: the sum
 * of the input + output per-MTok rates (catalog resolver wins over the seed).
 * Undefined for an unpriced model, so the caller ranks it last. Not a billing
 * figure — a cheap comparable for "which target is cheapest for this model".
 */
export function rankPrice(
  provider: string,
  model: string,
  resolve?: RateResolver,
): number | undefined {
  const pricing = PROVIDER_PRICING[provider];
  const rate = resolve?.(provider, model) ?? pricing?.rates[pricing.normalize(model)];
  return rate ? rate.input + rate.output : undefined;
}

export function computeCost(
  provider: string,
  model: string,
  u: NormalizedUsage,
  resolve?: RateResolver,
): CostBreakdown {
  const cacheWriteTokens = u.cacheWrite5mTokens + u.cacheWrite1hTokens;
  const totalInputTokens = u.inputTokens + u.cacheReadTokens + cacheWriteTokens;
  const base = {
    provider,
    model,
    inputTokens: u.inputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens,
    outputTokens: u.outputTokens,
    totalInputTokens,
  };

  // An external catalog (models.dev) wins when it knows the model; otherwise fall
  // back to the in-tree seed table. Either way an unknown model still meters
  // tokens with priced: false rather than guessing.
  const pricing = PROVIDER_PRICING[provider];
  const override = resolve?.(provider, model);
  const rate = override ?? pricing?.rates[pricing.normalize(model)];
  const cache = override?.cache ?? pricing?.cache ?? NEUTRAL_CACHE;
  if (!rate) {
    return {
      ...base,
      priced: false,
      inputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
      cacheSavedUsd: 0,
    };
  }

  const inputUsd = perMillion(u.inputTokens, rate.input);
  const cacheReadUsd = perMillion(u.cacheReadTokens, rate.input * cache.read);
  const cacheWriteUsd =
    perMillion(u.cacheWrite5mTokens, rate.input * cache.write5m) +
    perMillion(u.cacheWrite1hTokens, rate.input * cache.write1h);
  const outputUsd = perMillion(u.outputTokens, rate.output);
  // What cache_read tokens would have cost at the full input rate, minus what they
  // did cost at the discounted rate — the provider-prompt-cache dollars saved.
  const cacheSavedUsd = perMillion(u.cacheReadTokens, rate.input * (1 - cache.read));

  return {
    ...base,
    priced: true,
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    cacheSavedUsd,
  };
}

/** Round a USD amount to whole micro-dollars (6 dp) for ledger storage. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}
