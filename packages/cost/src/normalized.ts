/**
 * Provider-agnostic token usage. Each provider adapter maps its raw usage object
 * into this shape (accounting for that provider's inclusion semantics — e.g.
 * OpenAI's prompt_tokens includes cached tokens, Anthropic's input_tokens does
 * not), and the cost function prices it against per-provider rates.
 */
export interface NormalizedUsage {
  model?: string;
  /** Uncached input tokens. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  stopReason?: string | null;
  /** True once a real usage object has been observed. */
  seen: boolean;
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    seen: false,
  };
}
