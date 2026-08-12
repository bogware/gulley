import { CACHE_MULTIPLIERS, lookupRate } from './pricing';

/**
 * Raw Anthropic usage object. We meter ONLY from these provider-reported fields,
 * never from local token estimates. Anthropic's `input_tokens` EXCLUDES cache
 * tokens, so true input = input_tokens + cache_read + cache_creation.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** Present on newer API versions; splits cache-creation by TTL. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}

export interface CostBreakdown {
  model: string;
  priced: boolean;
  /** Uncached input tokens (Anthropic `input_tokens`). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** input + cache_read + cache_creation — the true billable input. */
  totalInputTokens: number;
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
}

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

/**
 * Compute cost from a raw Anthropic usage object. Cache-creation is priced at
 * the 5m multiplier unless the TTL breakdown says otherwise. Always returns
 * token totals so an unknown/unpriced model still meters usage.
 */
export function computeAnthropicCost(model: string, usage: AnthropicUsage): CostBreakdown {
  const inputTokens = usage.input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;

  const rate = lookupRate(model);
  if (!rate) {
    return {
      model,
      priced: false,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      totalInputTokens,
      inputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
    };
  }

  // With a per-TTL breakdown, split by it (each side defaulting to 0). Without
  // one, all cache-creation tokens are priced at the 5m rate.
  const hasBreakdown = usage.cache_creation != null;
  const write5m = hasBreakdown
    ? (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0)
    : cacheWriteTokens;
  const write1h = hasBreakdown ? (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) : 0;

  const inputUsd = perMillion(inputTokens, rate.input);
  const cacheReadUsd = perMillion(cacheReadTokens, rate.input * CACHE_MULTIPLIERS.read);
  const cacheWriteUsd =
    perMillion(write5m, rate.input * CACHE_MULTIPLIERS.write5m) +
    perMillion(write1h, rate.input * CACHE_MULTIPLIERS.write1h);
  const outputUsd = perMillion(outputTokens, rate.output);

  return {
    model,
    priced: true,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalInputTokens,
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
  };
}

/** Round a USD amount to whole micro-dollars (6 dp) for ledger storage. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}
