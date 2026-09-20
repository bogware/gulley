import type { AnthropicUsage } from '@gulley/cost';
import type { SSEEvent } from './sse';

export interface AnthropicStreamUsage extends AnthropicUsage {
  model?: string;
  stopReason?: string | null;
}

/**
 * Accumulates usage from an Anthropic Messages stream. Per the API:
 * input + cache tokens arrive in `message_start.usage`; the final `output_tokens`
 * arrives in `message_delta.usage`. Also handles the non-streaming JSON shape.
 */
export class AnthropicUsageAccumulator {
  private usage: AnthropicStreamUsage = { input_tokens: 0, output_tokens: 0 };
  private seen = false;

  ingest(events: SSEEvent[]): void {
    for (const ev of events) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = ev.event ?? (payload['type'] as string | undefined);

      if (type === 'message_start') {
        const message = payload['message'] as Record<string, unknown> | undefined;
        const u = (message?.['usage'] as Record<string, unknown>) ?? {};
        this.usage.input_tokens = num(u['input_tokens']);
        this.usage.output_tokens = num(u['output_tokens']);
        this.usage.cache_creation_input_tokens = num(u['cache_creation_input_tokens']);
        this.usage.cache_read_input_tokens = num(u['cache_read_input_tokens']);
        if (u['cache_creation']) {
          this.usage.cache_creation = u['cache_creation'] as AnthropicUsage['cache_creation'];
        }
        this.usage.model = message?.['model'] as string | undefined;
        this.seen = true;
      } else if (type === 'message_delta') {
        const u = payload['usage'] as Record<string, unknown> | undefined;
        if (u && typeof u['output_tokens'] === 'number')
          this.usage.output_tokens = u['output_tokens'];
        if (u && typeof u['input_tokens'] === 'number') this.usage.input_tokens = u['input_tokens'];
        // Cumulative cache figures on the final delta: the translated (OpenAI/Gemini)
        // routes report cache reads ONLY here, and native Anthropic carries them here
        // too when server-side tools ran several sampling iterations. Ignoring them
        // billed every cached prompt token on a translated route at $0.
        if (u && typeof u['cache_read_input_tokens'] === 'number')
          this.usage.cache_read_input_tokens = u['cache_read_input_tokens'];
        if (u && typeof u['cache_creation_input_tokens'] === 'number')
          this.usage.cache_creation_input_tokens = u['cache_creation_input_tokens'];
        if (u && u['cache_creation'] && typeof u['cache_creation'] === 'object')
          this.usage.cache_creation = u['cache_creation'] as AnthropicUsage['cache_creation'];
        if (u) this.seen = true;
        const delta = payload['delta'] as Record<string, unknown> | undefined;
        if (delta && 'stop_reason' in delta)
          this.usage.stopReason = delta['stop_reason'] as string | null;
      }
    }
  }

  ingestJson(json: Record<string, unknown>): void {
    const u = json['usage'] as Record<string, unknown> | undefined;
    if (u) {
      this.usage.input_tokens = num(u['input_tokens']);
      this.usage.output_tokens = num(u['output_tokens']);
      this.usage.cache_creation_input_tokens = num(u['cache_creation_input_tokens']);
      this.usage.cache_read_input_tokens = num(u['cache_read_input_tokens']);
      if (u['cache_creation']) {
        this.usage.cache_creation = u['cache_creation'] as AnthropicUsage['cache_creation'];
      }
      this.seen = true;
    }
    if (json['model']) this.usage.model = json['model'] as string;
    if ('stop_reason' in json) this.usage.stopReason = json['stop_reason'] as string | null;
  }

  get(): AnthropicStreamUsage {
    return this.usage;
  }

  hasUsage(): boolean {
    return this.seen;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
