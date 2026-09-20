import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AnthropicUsageAccumulator } from './anthropic-usage';
import { PassthroughAdapter } from './anthropic';
import { BedrockAdapter } from './bedrock';
import { bedrockToSse } from './bedrock-eventstream';
import { OpenAIUsageExtractor } from './extractors';
import { anthropicToGemini, geminiSseToAnthropic } from './gemini';
import { MAX_RETRY_AFTER_MS, parseRetryAfterMs } from './retry-after';
import { SSEParser } from './sse';
import { canTranslateAnthropicToOpenAI, openaiChatSseToAnthropic } from './translate';
import { ProviderRequestError } from './types';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function encodeFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const hbufs: Buffer[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = Buffer.from(k, 'utf8');
    const val = Buffer.from(v, 'utf8');
    const b = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
    let o = 0;
    b.writeUInt8(name.length, o);
    o += 1;
    name.copy(b, o);
    o += name.length;
    b.writeUInt8(7, o);
    o += 1;
    b.writeUInt16BE(val.length, o);
    o += 2;
    val.copy(b, o);
    hbufs.push(b);
  }
  const hbuf = Buffer.concat(hbufs);
  const total = 12 + hbuf.length + payload.length + 4;
  const f = Buffer.alloc(total);
  f.writeUInt32BE(total, 0);
  f.writeUInt32BE(hbuf.length, 4);
  f.writeUInt32BE(0, 8);
  hbuf.copy(f, 12);
  payload.copy(f, 12 + hbuf.length);
  f.writeUInt32BE(0, total - 4);
  return f;
}

async function collect(r: Readable): Promise<{ text: string; error?: Error }> {
  let text = '';
  let error: Error | undefined;
  await new Promise<void>((resolve) => {
    r.on('data', (c: Buffer) => (text += c.toString('utf8')));
    r.on('error', (e: Error) => {
      error = e;
      resolve();
    });
    r.on('end', resolve);
    r.on('close', resolve);
  });
  return { text, error };
}

describe('Anthropic usage accumulator — cache tokens on the final delta', () => {
  it('takes cache_read/cache_creation from message_delta (translated routes report them only there)', () => {
    const acc = new AnthropicUsageAccumulator();
    acc.ingest([
      {
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 50 },
        }),
      },
    ]);
    expect(acc.get().cache_read_input_tokens).toBe(4000);
    expect(acc.get().input_tokens).toBe(1000);
    expect(acc.hasUsage()).toBe(true);
  });
});

describe('OpenAI extractor — non-streamed finish_reason', () => {
  it('reads choices[0].finish_reason from a chat.completions JSON body', () => {
    const x = new OpenAIUsageExtractor();
    x.ingestJson({
      choices: [{ finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(x.normalized().stopReason).toBe('length');
  });
});

describe('translators — in-band upstream error frames fail the stream', () => {
  it('OpenAI chat: a data:{"error":…} frame becomes event: error and the stream errors (no message_stop)', async () => {
    const up = new PassThrough();
    const out = openaiChatSseToAnthropic(up, 'gpt-x');
    const done = collect(out);
    up.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    up.write('data: {"error":{"message":"The server had an error","type":"server_error"}}\n\n');
    up.end();
    const r = await done;
    expect(r.text).toContain('event: error');
    expect(r.text).toContain('server had an error');
    expect(r.text).not.toContain('message_stop');
    expect(r.error).toBeDefined();
  });

  it('Gemini: promptFeedback.blockReason and {"error":…} both terminate with an error frame', async () => {
    for (const frame of [
      '{"promptFeedback":{"blockReason":"SAFETY"}}',
      '{"error":{"code":429,"message":"Resource exhausted"}}',
    ]) {
      const up = new PassThrough();
      const out = geminiSseToAnthropic(up, 'gemini-x');
      const done = collect(out);
      up.write(`data: ${frame}\n\n`);
      up.end();
      const r = await done;
      expect(r.text).toContain('event: error');
      expect(r.text).not.toContain('message_stop');
      expect(r.error).toBeDefined();
    }
  });
});

describe('Gemini request mapping', () => {
  it('maps thinking, top_k and tool_result.is_error, and echoes a tool_use signature', () => {
    const g = anthropicToGemini({
      model: 'gemini-x',
      top_k: 40,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 1 }, signature: 'SIG' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
        },
      ],
    }) as Record<string, unknown>;
    const gen = g['generationConfig'] as Record<string, unknown>;
    expect(gen['topK']).toBe(40);
    expect(gen['thinkingConfig']).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    const contents = g['contents'] as Array<{ parts: Array<Record<string, unknown>> }>;
    const call = contents[1]!.parts[0]!;
    expect(call['thoughtSignature']).toBe('SIG');
    const resp = contents[2]!.parts[0]!['functionResponse'] as {
      response: Record<string, unknown>;
    };
    expect(resp.response['error']).toBe(true);
  });

  it('relays a thoughtSignature on a functionCall part as a signature_delta on the tool_use block', async () => {
    const up = new PassThrough();
    const out = geminiSseToAnthropic(up, 'gemini-x');
    const done = collect(out);
    up.write(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":1}},"thoughtSignature":"CqQB"}]},"finishReason":"STOP"}]}\n\n',
    );
    up.end();
    const r = await done;
    expect(r.text).toContain('"signature_delta"');
    expect(r.text).toContain('CqQB');
    const ids = [...r.text.matchAll(/"id":"(msg_gulley_[a-f0-9]+)"/g)].map((m) => m[1]);
    expect(ids[0]).toMatch(/^msg_gulley_[a-f0-9]{16}$/);
  });
});

describe('cross-family preflight', () => {
  it('refuses tools / tool_choice / thinking at the top level (they would be dropped silently)', () => {
    const base = { messages: [{ role: 'user', content: 'hi' }] };
    expect(canTranslateAnthropicToOpenAI(base)).toBe(true);
    expect(canTranslateAnthropicToOpenAI({ ...base, tools: [{ name: 't' }] })).toBe(false);
    expect(canTranslateAnthropicToOpenAI({ ...base, tool_choice: { type: 'any' } })).toBe(false);
    expect(canTranslateAnthropicToOpenAI({ ...base, thinking: { type: 'enabled' } })).toBe(false);
  });
});

describe('Bedrock', () => {
  it('accepts an application-inference-profile ARN model id and rejects traversal as a CLIENT error', async () => {
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"message":"nope"}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const adapter = new BedrockAdapter({ baseUrl });
    const fwd = (model: string) =>
      adapter.forward({
        path: '/v1/messages',
        body: Buffer.from(JSON.stringify({ model, messages: [] })),
        headers: {},
        credential: { scheme: 'bearer', value: 'k' },
        signal: new AbortController().signal,
      });
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';
    const res = await fwd(arn);
    expect(res.statusCode).toBe(400); // reached the (mock) upstream
    expect(seen[0]).toContain(encodeURIComponent(arn));
    await expect(fwd('../../evil')).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(fwd('arn:aws:bedrock:us-east-1:1:bogus/../x')).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('eventstream: an exception frame is shaped as an Anthropic error frame and ENDS the stream cleanly behind it; an error frame too', async () => {
    for (const frame of [
      encodeFrame(
        { ':message-type': 'exception', ':exception-type': 'throttlingException' },
        Buffer.from('{"message":"Too many requests"}'),
      ),
      encodeFrame(
        { ':message-type': 'error', ':error-code': 'InternalError', ':error-message': 'boom' },
        Buffer.alloc(0),
      ),
    ]) {
      const up = new PassThrough();
      const out = bedrockToSse(up);
      const done = collect(out);
      up.write(frame);
      const r = await done;
      expect(r.text).toContain('event: error');
      expect(r.text).toMatch(
        /"type":"error","error":\{"type":"(throttlingException|InternalError)"/,
      );
      // The frame IS the failure signal (like Anthropic's own `event: error`): no
      // stream error behind it, so the gateway never appends a second generic frame.
      expect(r.error).toBeUndefined();
      expect(r.text.endsWith('\n\n')).toBe(true);
      expect(up.destroyed).toBe(true); // the upstream socket is released early
    }
  });

  it('eventstream: the shaped error frame survives client backpressure and an undici-style abort error on the destroyed upstream', async () => {
    // An undici body reports a plain destroy() as its own 'error' (RequestAbortedError).
    // That must not destroy the SSE stream and discard the frame still queued for a
    // slow client: the client reads the frame, then a clean end.
    class UndiciLikeBody extends Readable {
      override _read(): void {}
      override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
        cb(err ?? new Error('Request aborted'));
      }
    }
    const up = new UndiciLikeBody();
    const out = bedrockToSse(up);
    let error: Error | undefined;
    out.on('error', (e: Error) => (error = e));
    up.push(
      encodeFrame(
        { ':message-type': 'exception', ':exception-type': 'modelStreamErrorException' },
        Buffer.from('{"message":"stream broke"}'),
      ),
    );
    await new Promise((r) => setTimeout(r, 20)); // nobody is reading `out` yet (backpressure)
    expect(up.destroyed).toBe(true);
    const r = await collect(out); // the slow client finally drains
    expect(r.text).toContain('"type":"modelStreamErrorException"');
    expect(r.text).toContain('"message":"stream broke"');
    expect(r.error).toBeUndefined();
    expect(error).toBeUndefined();
  });
});

describe('SSEParser reset overflow keeps the events after the oversized one', () => {
  it('drops only the pending oversized event and still emits the next well-formed one', () => {
    const p = new SSEParser({ maxBufferBytes: 64, onOverflow: 'reset' });
    const events = p.push(`data: ${'x'.repeat(100)}\n\nevent: b\ndata: {}\n\n`);
    expect(events.map((e) => e.event)).toEqual(['b']);
  });
});

describe('parseRetryAfterMs — bounded and epoch-aware', () => {
  it('clamps absurd values and reads epoch-shaped resets as absolute times', () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfterMs({ 'retry-after': '99999999' }, now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfterMs({ 'x-ratelimit-reset': String(now / 1000 + 30) }, now)).toBe(30_000);
    expect(parseRetryAfterMs({ 'retry-after': '5' }, now)).toBe(5_000);
    expect(parseRetryAfterMs({ 'x-ratelimit-reset-requests': '6m0s' }, now)).toBe(
      MAX_RETRY_AFTER_MS,
    );
  });
});

describe('PassthroughAdapter header hygiene', () => {
  it('never forwards the caller network identity, cookies, tracing or org-steering headers', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const srv = http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const adapter = new PassthroughAdapter({ name: 'p', baseUrl });
    await adapter.forward({
      path: '/v1/messages',
      body: Buffer.from('{}'),
      headers: {
        'content-type': 'application/json',
        'anthropic-beta': 'x',
        cookie: 'session=abc',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'x-amzn-trace-id': 'Root=1',
        'openai-organization': 'org-other',
        'x-gulley-request-id': 'req_1',
        'x-custom': 'kept',
      },
      credential: { scheme: 'x-api-key', value: 'k' },
      signal: new AbortController().signal,
    });
    for (const h of [
      'cookie',
      'x-forwarded-for',
      'x-real-ip',
      'x-amzn-trace-id',
      'openai-organization',
      'x-gulley-request-id',
    ])
      expect(seen[h], h).toBeUndefined();
    expect(seen['anthropic-beta']).toBe('x');
    expect(seen['x-custom']).toBe('kept');
    await new Promise<void>((r) => srv.close(() => r()));
  });
});
