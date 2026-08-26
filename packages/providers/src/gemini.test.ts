import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  anthropicToGemini,
  canTranslateAnthropicToGemini,
  GeminiNativeAdapter,
  geminiSseToAnthropic,
} from './gemini';
import type { ForwardRequest, ForwardResponse, ProviderAdapter } from './types';

async function collect(r: Readable): Promise<string> {
  let s = '';
  for await (const c of r) s += (c as Buffer).toString('utf8');
  return s;
}

describe('anthropicToGemini (request)', () => {
  it('maps roles, system, generationConfig, and round-trips a thinking signature', () => {
    const g = anthropicToGemini({
      system: 'You are helpful',
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'S1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    });
    expect(g['contents']).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'model',
        parts: [{ thought: true, text: 'hmm', thoughtSignature: 'S1' }, { text: 'hello' }],
      },
    ]);
    expect(g['systemInstruction']).toEqual({ parts: [{ text: 'You are helpful' }] });
    expect(g['generationConfig']).toEqual({
      maxOutputTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ['STOP'],
    });
  });
});

describe('canTranslateAnthropicToGemini', () => {
  it('allows text + thinking, refuses tool/image', () => {
    expect(canTranslateAnthropicToGemini({ messages: [{ role: 'user', content: 'hi' }] })).toBe(
      true,
    );
    expect(
      canTranslateAnthropicToGemini({
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }],
      }),
    ).toBe(true);
    expect(
      canTranslateAnthropicToGemini({
        messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
      }),
    ).toBe(false);
    expect(
      canTranslateAnthropicToGemini({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f' }] }],
      }),
    ).toBe(false);
  });
});

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"Let me think"}]}}],"usageMetadata":{"promptTokenCount":10}}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"thoughtSignature":"SIG123"}]}}]}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3,"cachedContentTokenCount":2}}',
  '',
  '',
].join('\n');

describe('geminiSseToAnthropic (streaming response)', () => {
  it('emits a thinking block with the signature, a text block, and mapped usage', async () => {
    const out = await collect(geminiSseToAnthropic(Readable.from([GEMINI_SSE]), 'gemini-2.5-pro'));

    expect(out).toContain('event: message_start');
    // thinking block with the reasoning text AND the thoughtSignature round-tripped
    expect(out).toContain('"type":"thinking"');
    expect(out).toContain('"thinking":"Let me think"');
    expect(out).toContain('"type":"signature_delta","signature":"SIG123"');
    // then a text block
    expect(out).toContain('"type":"text_delta","text":"Hello world"');
    // usage: input = prompt(10) - cached(2) = 8; cache_read = 2; output = cand(5)+thoughts(3) = 8
    expect(out).toContain('"input_tokens":8');
    expect(out).toContain('"cache_read_input_tokens":2');
    expect(out).toContain('"output_tokens":8');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('event: message_stop');

    // block ordering: thinking (index 0) closes before text (index 1) opens
    expect(out.indexOf('"index":0')).toBeLessThan(out.indexOf('"index":1'));
    expect(out).toContain('"type":"content_block_stop","index":0');
  });
});

describe('GeminiNativeAdapter', () => {
  it('translates the request, rewrites the path, and emits Anthropic SSE', async () => {
    let seenPath = '';
    let seenBody = '';
    const inner: ProviderAdapter = {
      name: 'inner',
      async forward(req: ForwardRequest): Promise<ForwardResponse> {
        seenPath = req.path;
        seenBody = req.body.toString('utf8');
        return { statusCode: 200, headers: {}, body: Readable.from([GEMINI_SSE]) };
      },
    };
    const adapter = new GeminiNativeAdapter({ inner, targetModel: 'gemini-2.5-pro' });

    const resp = await adapter.forward({
      path: '/v1/messages',
      body: Buffer.from(
        JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }),
      ),
      headers: {},
      credential: { scheme: 'bearer', value: 'ya29.token' },
      signal: new AbortController().signal,
    });

    expect(seenPath).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(JSON.parse(seenBody)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 50 },
    });
    expect(resp.statusCode).toBe(200);
    const out = await collect(resp.body);
    expect(out).toContain('"type":"signature_delta","signature":"SIG123"');
  });

  it('mints a Bearer credential from the token provider (auto-rotating Vertex token)', async () => {
    let seenCred: { scheme: string; value: string } | undefined;
    const inner: ProviderAdapter = {
      name: 'inner',
      async forward(req: ForwardRequest): Promise<ForwardResponse> {
        seenCred = req.credential;
        return { statusCode: 200, headers: {}, body: Readable.from([GEMINI_SSE]) };
      },
    };
    const adapter = new GeminiNativeAdapter({
      inner,
      targetModel: 'gemini-2.5-pro',
      pathTemplate:
        '/v1/projects/p/locations/l/publishers/google/models/{model}:streamGenerateContent?alt=sse',
      tokenProvider: { getToken: async () => 'ya29.minted' },
    });

    const resp = await adapter.forward({
      path: '/v1/messages',
      body: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })),
      headers: {},
      credential: { scheme: 'x-api-key', value: 'ignored-static' },
      signal: new AbortController().signal,
    });
    resp.body.resume();

    expect(seenCred).toEqual({ scheme: 'bearer', value: 'ya29.minted' }); // minted, not static
  });

  it('refuses a request carrying provider-affine (tool/image) content', async () => {
    const inner: ProviderAdapter = {
      name: 'inner',
      forward: () => Promise.reject(new Error('should not be called')),
    };
    const adapter = new GeminiNativeAdapter({ inner, targetModel: 'gemini-2.5-pro' });
    await expect(
      adapter.forward({
        path: '/v1/messages',
        body: Buffer.from(
          JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }),
        ),
        headers: {},
        credential: { scheme: 'bearer', value: 't' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/provider-affine/);
  });
});
