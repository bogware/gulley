import { anthropicToNormalized, type NormalizedUsage } from '@gulley/cost';
import { AnthropicUsageAccumulator } from './anthropic-usage';
import type { SSEEvent } from './sse';
import type { UsageExtractor } from './types';

export class AnthropicUsageExtractor implements UsageExtractor {
  private readonly acc = new AnthropicUsageAccumulator();

  ingestSse(events: SSEEvent[]): void {
    this.acc.ingest(events);
  }

  ingestJson(json: Record<string, unknown>): void {
    this.acc.ingestJson(json);
  }

  normalized(): NormalizedUsage {
    const u = this.acc.get();
    return {
      ...anthropicToNormalized(u),
      model: u.model,
      stopReason: u.stopReason,
      seen: this.acc.hasUsage(),
    };
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Extracts usage from OpenAI Chat Completions AND the Responses API, streaming
 * and non-streaming. Chat reports prompt_tokens/completion_tokens (prompt
 * INCLUDES cached); Responses reports input_tokens/output_tokens (input INCLUDES
 * cached). Both normalize to uncached-input + cache-read + output. OpenAI has no
 * separate cache-write charge, so the write buckets stay zero.
 */
export class OpenAIUsageExtractor implements UsageExtractor {
  private model: string | undefined;
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private outputTokens = 0;
  private stopReason: string | null | undefined;
  private seen = false;

  ingestSse(events: SSEEvent[]): void {
    for (const ev of events) {
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        continue; // e.g. the literal `[DONE]` terminator
      }
      if (typeof p['model'] === 'string') this.model = p['model'];
      const type = ev.event ?? (p['type'] as string | undefined);
      const response = p['response'] as Record<string, unknown> | undefined;

      if (type === 'response.completed' && response) {
        if (typeof response['model'] === 'string') this.model = response['model'];
        if (typeof response['status'] === 'string') this.stopReason = response['status'];
        const u = response['usage'] as Record<string, unknown> | undefined;
        if (u) this.apply(u);
      } else {
        const u = p['usage'] as Record<string, unknown> | undefined;
        if (u) this.apply(u); // chat completions final usage chunk
        const choices = p['choices'] as Array<Record<string, unknown>> | undefined;
        const finish = choices?.[0]?.['finish_reason'];
        if (typeof finish === 'string') this.stopReason = finish;
      }
    }
  }

  ingestJson(json: Record<string, unknown>): void {
    if (typeof json['model'] === 'string') this.model = json['model'];
    const response = json['response'] as Record<string, unknown> | undefined;
    const u = (json['usage'] ?? response?.['usage']) as Record<string, unknown> | undefined;
    if (u) this.apply(u);
    if (typeof json['status'] === 'string') this.stopReason = json['status'];
  }

  private apply(u: Record<string, unknown>): void {
    const promptTotal = num(u['prompt_tokens'] ?? u['input_tokens']);
    const details = (u['prompt_tokens_details'] ?? u['input_tokens_details']) as
      Record<string, unknown> | undefined;
    const cached = num(details?.['cached_tokens']);
    this.inputTokens = Math.max(0, promptTotal - cached);
    this.cacheReadTokens = cached;
    this.outputTokens = num(u['completion_tokens'] ?? u['output_tokens']);
    this.seen = true;
  }

  normalized(): NormalizedUsage {
    return {
      model: this.model,
      inputTokens: this.inputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: this.outputTokens,
      stopReason: this.stopReason,
      seen: this.seen,
    };
  }
}
