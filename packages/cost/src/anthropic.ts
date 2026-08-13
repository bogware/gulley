import { type CostBreakdown, computeCost } from './compute';
import type { NormalizedUsage } from './normalized';

/**
 * Raw Anthropic usage object. Anthropic's `input_tokens` EXCLUDES cache tokens,
 * so true input = input_tokens + cache_read + cache_creation.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}

export function anthropicToNormalized(usage: AnthropicUsage): NormalizedUsage {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const hasBreakdown = usage.cache_creation != null;
  const write5m = hasBreakdown
    ? (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0)
    : cacheWrite;
  const write1h = hasBreakdown ? (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) : 0;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    outputTokens: usage.output_tokens ?? 0,
    seen: true,
  };
}

export function computeAnthropicCost(model: string, usage: AnthropicUsage): CostBreakdown {
  return computeCost('anthropic', model, { ...anthropicToNormalized(usage), model });
}
