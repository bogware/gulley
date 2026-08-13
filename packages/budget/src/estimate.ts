import { computeCost, toMicroUsd } from '@gulley/cost';

/** Deliberately low chars-per-token so input tokens are OVER-estimated — a hard
 *  cap should reserve conservatively (reject early rather than overspend). */
const CHARS_PER_TOKEN = 3;

export function estimateInputTokens(bodyBytes: number): number {
  return Math.ceil(bodyBytes / CHARS_PER_TOKEN);
}

/**
 * Worst-case cost of a request: over-estimated input + the full requested output
 * budget, priced at the target provider/model. Used for the admission reserve.
 */
export function estimateWorstCaseMicroUsd(
  provider: string,
  model: string,
  bodyBytes: number,
  maxOutputTokens: number,
): number {
  const cost = computeCost(provider, model, {
    inputTokens: estimateInputTokens(bodyBytes),
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: maxOutputTokens,
    seen: true,
  });
  return toMicroUsd(cost.totalUsd);
}
