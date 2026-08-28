import { computeCost, type RateResolver, toMicroUsd } from '@gulley/cost';

/** Deliberately low chars-per-token so input tokens are OVER-estimated — a hard
 *  cap should reserve conservatively (reject early rather than overspend). */
const CHARS_PER_TOKEN = 3;

// Conservative fallback rates (USD/token) for a model with UNKNOWN pricing, so a
// budget cannot be bypassed by requesting an unpriced model (e.g. an arbitrary
// Azure deployment name). Set to the priciest tier we front (Opus/GPT-4-class).
const FALLBACK_INPUT_USD_PER_TOKEN = 15 / 1_000_000;
const FALLBACK_OUTPUT_USD_PER_TOKEN = 75 / 1_000_000;

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
  /** Catalog rate resolver — MUST be the same one used at commit so admission and
   *  commit price identically. Without it, catalog-priced-but-unseeded models
   *  (Gemini/Vertex/Groq/…) reserve at the unknown-pricing floor and spuriously
   *  402 legitimate cheap traffic while commit prices them correctly. */
  resolve?: RateResolver,
): number {
  const inputTokens = estimateInputTokens(bodyBytes);
  const cost = computeCost(
    provider,
    model,
    {
      inputTokens,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: maxOutputTokens,
      seen: true,
    },
    resolve,
  );
  if (cost.priced) return toMicroUsd(cost.totalUsd);
  // Unknown pricing → reserve a conservative floor so the model can't slip a
  // budget by pricing to $0 (admission control; actual spend still meters as
  // priced=false at commit).
  const floorUsd =
    inputTokens * FALLBACK_INPUT_USD_PER_TOKEN + maxOutputTokens * FALLBACK_OUTPUT_USD_PER_TOKEN;
  return toMicroUsd(floorUsd);
}
