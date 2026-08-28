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
  it('allows text, thinking, tool_use, tool_result, and base64 images', () => {
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
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAA' } }] },
        ],
      }),
    ).toBe(true);
    expect(
      canTranslateAnthropicToGemini({
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f' }] }],
      }),
    ).toBe(true);
  });

  it('still refuses a URL-sourced image (Gemini inlineData is base64-only)', () => {
    expect(
      canTranslateAnthropicToGemini({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('anthropicToGemini (tools + images)', () => {
  it('maps tool_use/tool_result (resolving id->name), tools, tool_choice, and images', () => {
    const g = anthropicToGemini({
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'weather?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'SF' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '72F' }],
        },
      ],
    });
    expect(g['contents']).toEqual([
      {
        role: 'user',
        parts: [{ text: 'weather?' }, { inlineData: { mimeType: 'image/png', data: 'AAA' } }],
      },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { result: '72F' } } }],
      },
    ]);
    expect(g['tools']).toEqual([
      {
        functionDeclarations: [
          { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
        ],
      },
    ]);
    expect(g['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('maps tool_choice auto/any/none', () => {
    expect(
      anthropicToGemini({ tool_choice: { type: 'auto' }, messages: [] })['toolConfig'],
    ).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(anthropicToGemini({ tool_choice: { type: 'any' }, messages: [] })['toolConfig']).toEqual(
      {
        functionCallingConfig: { mode: 'ANY' },
      },
    );
    expect(
      anthropicToGemini({ tool_choice: { type: 'none' }, messages: [] })['toolConfig'],
    ).toEqual({ functionCallingConfig: { mode: 'NONE' } });
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

  it('translates a functionCall part into a tool_use block with stop_reason tool_use', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Checking"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"SF"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":4}}',
      '',
      '',
    ].join('\n');
    const out = await collect(geminiSseToAnthropic(Readable.from([sse]), 'gemini-2.5-pro'));

    // text block (index 0) closes before the tool_use block (index 1) opens
    expect(out).toContain('"type":"content_block_stop","index":0');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"get_weather"');
    expect(out).toContain('"type":"input_json_delta","partial_json":"{\\"city\\":\\"SF\\"}"');
    // atomic: the tool_use block is closed
    expect(out).toContain('"type":"content_block_stop","index":1');
    // Gemini reports STOP, but a functionCall part forces stop_reason tool_use
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  it('translates an inlineData output part into an image content block', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"BBB"}}]},"finishReason":"STOP"}]}',
      '',
      '',
    ].join('\n');
    const out = await collect(geminiSseToAnthropic(Readable.from([sse]), 'gemini-2.5-pro'));
    expect(out).toContain('"type":"image"');
    expect(out).toContain('"media_type":"image/png"');
    expect(out).toContain('"data":"BBB"');
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

  it('translates a tool request instead of refusing it', async () => {
    let seenBody = '';
    const inner: ProviderAdapter = {
      name: 'inner',
      async forward(req: ForwardRequest): Promise<ForwardResponse> {
        seenBody = req.body.toString('utf8');
        return { statusCode: 200, headers: {}, body: Readable.from([GEMINI_SSE]) };
      },
    };
    const adapter = new GeminiNativeAdapter({ inner, targetModel: 'gemini-2.5-pro' });
    const resp = await adapter.forward({
      path: '/v1/messages',
      body: Buffer.from(
        JSON.stringify({
          tools: [{ name: 'f', input_schema: { type: 'object' } }],
          messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }] },
          ],
        }),
      ),
      headers: {},
      credential: { scheme: 'bearer', value: 't' },
      signal: new AbortController().signal,
    });
    resp.body.resume();
    expect(JSON.parse(seenBody)['tools']).toEqual([
      { functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] },
    ]);
  });

  it('still refuses a URL-sourced image (untranslatable to inlineData)', async () => {
    const inner: ProviderAdapter = {
      name: 'inner',
      forward: () => Promise.reject(new Error('should not be called')),
    };
    const adapter = new GeminiNativeAdapter({ inner, targetModel: 'gemini-2.5-pro' });
    await expect(
      adapter.forward({
        path: '/v1/messages',
        body: Buffer.from(
          JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [{ type: 'image', source: { type: 'url', url: 'http://x' } }],
              },
            ],
          }),
        ),
        headers: {},
        credential: { scheme: 'bearer', value: 't' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/provider-affine/);
  });
});
