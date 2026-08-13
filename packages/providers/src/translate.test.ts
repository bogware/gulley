import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AnthropicUsageExtractor } from './extractors';
import { SSEParser } from './sse';
import {
  anthropicMessagesToOpenAIChat,
  canTranslateAnthropicToOpenAI,
  openaiChatSseToAnthropic,
} from './translate';

const OPENAI_SSE = [
  'data: {"model":"gpt-4o-mini","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

async function collect(r: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('anthropicMessagesToOpenAIChat', () => {
  it('maps system + messages + max_tokens and requests usage', () => {
    const openai = anthropicMessagesToOpenAIChat(
      {
        model: 'claude-haiku-4-5',
        system: 'Be terse.',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
      'gpt-4o-mini',
    );
    expect(openai['model']).toBe('gpt-4o-mini');
    expect(openai['max_tokens']).toBe(16);
    expect(openai['stream_options']).toEqual({ include_usage: true });
    expect(openai['messages']).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('flattens text content blocks', () => {
    const openai = anthropicMessagesToOpenAIChat(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      },
      'gpt-4o-mini',
    );
    expect((openai['messages'] as Array<{ content: string }>)[0]?.content).toBe('ab');
  });
});

describe('canTranslateAnthropicToOpenAI', () => {
  it('allows text, pins provider-affine content to origin', () => {
    expect(canTranslateAnthropicToOpenAI({ messages: [{ role: 'user', content: 'hi' }] })).toBe(
      true,
    );
    expect(
      canTranslateAnthropicToOpenAI({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
        ],
      }),
    ).toBe(false);
  });
});

describe('openaiChatSseToAnthropic', () => {
  it('translates an OpenAI stream into Anthropic SSE, mapping usage + stop_reason', async () => {
    const anthropicSse = await collect(
      openaiChatSseToAnthropic(Readable.from([OPENAI_SSE]), 'gpt-4o-mini'),
    );

    // Well-formed Anthropic event sequence.
    expect(anthropicSse).toContain('event: message_start');
    expect(anthropicSse).toContain('event: content_block_delta');
    expect(anthropicSse).toContain('"text":"Hello"');
    expect(anthropicSse).toContain('"stop_reason":"end_turn"');
    expect(anthropicSse).toContain('event: message_stop');

    // The gateway's Anthropic extractor meters the translated stream correctly.
    const ex = new AnthropicUsageExtractor();
    ex.ingestSse(new SSEParser().push(anthropicSse));
    const u = ex.normalized();
    expect(u.model).toBe('gpt-4o-mini');
    expect(u.inputTokens).toBe(9);
    expect(u.outputTokens).toBe(2);
  });
});
