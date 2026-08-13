import type { NormalizedUsage } from './normalized';
import { PROVIDER_PRICING } from './pricing';

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
}

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

/**
 * Price normalized usage against a provider's rate table. Always returns token
 * totals, so an unknown provider or model still meters usage (priced: false).
 */
export function computeCost(provider: string, model: string, u: NormalizedUsage): CostBreakdown {
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

  const pricing = PROVIDER_PRICING[provider];
  const rate = pricing?.rates[pricing.normalize(model)];
  if (!pricing || !rate) {
    return {
      ...base,
      priced: false,
      inputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
    };
  }

  const inputUsd = perMillion(u.inputTokens, rate.input);
  const cacheReadUsd = perMillion(u.cacheReadTokens, rate.input * pricing.cache.read);
  const cacheWriteUsd =
    perMillion(u.cacheWrite5mTokens, rate.input * pricing.cache.write5m) +
    perMillion(u.cacheWrite1hTokens, rate.input * pricing.cache.write1h);
  const outputUsd = perMillion(u.outputTokens, rate.output);

  return {
    ...base,
    priced: true,
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
