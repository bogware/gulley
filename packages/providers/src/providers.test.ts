import { describe, expect, it } from 'vitest';
import { computeAnthropicCost } from '@gulley/cost';
import { AnthropicUsageAccumulator } from './anthropic-usage';
import { SSEParser } from './sse';

const GOLDEN_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":10,"output_tokens":1}}}',
  '',
  ': ping',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

describe('SSEParser', () => {
  it('parses events and ignores heartbeats', () => {
    const p = new SSEParser();
    const events = p.push(GOLDEN_SSE);
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'message_delta',
      'message_stop',
    ]);
  });

  it('reassembles events split across chunk boundaries', () => {
    const p = new SSEParser();
    const mid = Math.floor(GOLDEN_SSE.length / 2);
    const first = p.push(GOLDEN_SSE.slice(0, mid));
    const second = p.push(GOLDEN_SSE.slice(mid));
    expect(first.length + second.length).toBe(5);
  });
});

describe('AnthropicUsageAccumulator', () => {
  it('takes input+cache from message_start and final output from message_delta', () => {
    const acc = new AnthropicUsageAccumulator();
    const p = new SSEParser();
    acc.ingest(p.push(GOLDEN_SSE));

    const u = acc.get();
    expect(acc.hasUsage()).toBe(true);
    expect(u.input_tokens).toBe(100);
    expect(u.cache_read_input_tokens).toBe(20);
    expect(u.cache_creation_input_tokens).toBe(10);
    expect(u.output_tokens).toBe(42); // NOT the 1 from message_start
    expect(u.model).toBe('claude-sonnet-4-6');
    expect(u.stopReason).toBe('end_turn');
  });

  it('feeds cleanly into the cost function', () => {
    const acc = new AnthropicUsageAccumulator();
    acc.ingest(new SSEParser().push(GOLDEN_SSE));
    const cost = computeAnthropicCost(acc.get().model ?? '', acc.get());
    expect(cost.priced).toBe(true);
    expect(cost.totalInputTokens).toBe(130); // 100 + 20 + 10
    expect(cost.outputTokens).toBe(42);
  });

  it('extracts usage from a non-streaming JSON body', () => {
    const acc = new AnthropicUsageAccumulator();
    acc.ingestJson({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(acc.get().output_tokens).toBe(7);
    expect(acc.get().model).toBe('claude-opus-5');
  });
});
