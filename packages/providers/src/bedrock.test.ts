import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BedrockAdapter } from './bedrock';
import { bedrockToSse } from './bedrock-eventstream';
import { AnthropicUsageExtractor } from './extractors';
import { SSEParser } from './sse';

/** Build one AWS eventstream frame with string headers and a raw payload. */
function buildFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const headerBufs: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    b.writeUInt8(n.length, o);
    o += 1;
    n.copy(b, o);
    o += n.length;
    b.writeUInt8(7, o); // 7 = string
    o += 1;
    b.writeUInt16BE(v.length, o);
    o += 2;
    v.copy(b, o);
    headerBufs.push(b);
  }
  const headersBuf = Buffer.concat(headerBufs);
  const total = 4 + 4 + 4 + headersBuf.length + payload.length + 4;
  const frame = Buffer.alloc(total);
  let o = 0;
  frame.writeUInt32BE(total, o);
  o += 4;
  frame.writeUInt32BE(headersBuf.length, o);
  o += 4;
  frame.writeUInt32BE(0, o); // prelude crc (ignored by our parser)
  o += 4;
  headersBuf.copy(frame, o);
  o += headersBuf.length;
  payload.copy(frame, o);
  o += payload.length;
  frame.writeUInt32BE(0, o); // message crc (ignored)
  return frame;
}

function chunkFrame(anthropicEvent: object): Buffer {
  const inner = Buffer.from(JSON.stringify(anthropicEvent), 'utf8').toString('base64');
  const payload = Buffer.from(JSON.stringify({ bytes: inner }), 'utf8');
  return buildFrame({ ':message-type': 'event', ':event-type': 'chunk' }, payload);
}

async function collect(readable: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('bedrockToSse', () => {
  it('decodes eventstream chunks into Anthropic SSE and meters usage', async () => {
    const frames = Buffer.concat([
      chunkFrame({
        type: 'message_start',
        message: { model: 'claude-3-haiku', usage: { input_tokens: 15, output_tokens: 1 } },
      }),
      chunkFrame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      }),
      chunkFrame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      }),
      chunkFrame({ type: 'message_stop' }),
    ]);

    // Split mid-frame to exercise reassembly across chunk boundaries.
    const upstream = Readable.from([frames.subarray(0, 30), frames.subarray(30)]);
    const sse = await collect(bedrockToSse(upstream));

    expect(sse).toContain('event: message_start');
    expect(sse).toContain('"stop_reason":"end_turn"');

    const ex = new AnthropicUsageExtractor();
    ex.ingestSse(new SSEParser().push(sse));
    const u = ex.normalized();
    expect(u.inputTokens).toBe(15);
    expect(u.outputTokens).toBe(3); // from message_delta, not the 1 in message_start
    expect(u.model).toBe('claude-3-haiku');
  });
});

describe('BedrockAdapter delivery modes', () => {
  it('routes stream:false to /invoke (JSON passthrough) and stream:true to the eventstream path', async () => {
    const seen: Array<{ path: string; accept: string | undefined; body: string }> = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', accept: req.headers['accept'], body: b });
        if (req.url?.endsWith('/invoke')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_1',
              type: 'message',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
          res.end(chunkFrame({ type: 'message_stop' }));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const adapter = new BedrockAdapter({ baseUrl });
    const fwd = (stream: boolean) =>
      adapter.forward({
        path: '/v1/messages',
        body: Buffer.from(
          JSON.stringify({ model: 'claude-x', stream, max_tokens: 5, messages: [] }),
        ),
        headers: {},
        credential: { scheme: 'bearer', value: 'k' },
        signal: new AbortController().signal,
      });

    const json = await fwd(false);
    expect(seen[0]?.path).toBe('/model/claude-x/invoke');
    expect(seen[0]?.accept).toBe('application/json');
    expect(JSON.parse(seen[0]?.body ?? '{}')).not.toHaveProperty('stream');
    expect(json.headers['content-type']).toBe('application/json');
    expect(JSON.parse(await collect(json.body))).toMatchObject({ type: 'message' });

    const sse = await fwd(true);
    expect(seen[1]?.path).toBe('/model/claude-x/invoke-with-response-stream');
    expect(sse.headers['content-type']).toBe('text/event-stream');
    expect(await collect(sse.body)).toContain('message_stop');

    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe('BedrockAdapter — gateway contract (Wave 1)', () => {
  type Captured = { path: string; body: string; headers: http.IncomingHttpHeaders };
  async function mock(
    handler: (c: Captured, res: http.ServerResponse) => void,
  ): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
    const captured: Captured[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        const c = { path: req.url ?? '', body: b, headers: req.headers };
        captured.push(c);
        handler(c, res);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      captured,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }
  const req = (body: unknown, headers: Record<string, string> = {}) => ({
    path: '/v1/messages',
    body: Buffer.from(JSON.stringify(body)),
    headers,
    credential: { scheme: 'bearer' as const, value: 'k' },
    signal: new AbortController().signal,
  });
  const drain = async (body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  it('forwards the anthropic-beta header as the body anthropic_beta list (open list, deny-filtered)', async () => {
    const up = await mock((_c, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"m"}');
    });
    const adapter = new BedrockAdapter({
      baseUrl: up.url,
      betaDeny: ['context-management-2025-06-27'],
    });
    await adapter.forward(
      req(
        { model: 'anthropic.claude-sonnet-5-5', max_tokens: 5, messages: [] },
        {
          'anthropic-beta':
            'interleaved-thinking-2025-05-14, context-management-2025-06-27,output-128k-2025-02-19',
        },
      ),
    );
    const sent = JSON.parse(up.captured[0]!.body) as { anthropic_beta?: string[]; model?: unknown };
    expect(sent.anthropic_beta).toEqual([
      'interleaved-thinking-2025-05-14',
      'output-128k-2025-02-19',
    ]);
    expect(sent.model).toBeUndefined();
    // A body that already carries anthropic_beta wins over the header.
    await adapter.forward(
      req(
        { model: 'anthropic.claude-sonnet-5-5', anthropic_beta: ['x'], messages: [] },
        { 'anthropic-beta': 'y' },
      ),
    );
    expect(
      (JSON.parse(up.captured[1]!.body) as { anthropic_beta: string[] }).anthropic_beta,
    ).toEqual(['x']);
    await up.close();
  });

  it('reshapes HTTP errors into the Anthropic envelope: status kept, prompt-too-long gets the capability_rejected token', async () => {
    const up = await mock((c, res) => {
      if (c.path.includes('too-long')) {
        res.writeHead(400, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'ValidationException:http://internal',
        });
        res.end('{"message":"Input is too long for requested model."}');
      } else if (c.path.includes('throttle')) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'ThrottlingException',
          'retry-after': '3',
        });
        res.end('{"message":"Too many requests, please wait before trying again."}');
      } else {
        res.writeHead(400, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'ValidationException',
        });
        res.end('{"message":"extra_field: Extra inputs are not permitted"}');
      }
    });
    const adapter = new BedrockAdapter({ baseUrl: up.url });
    const r1 = await adapter.forward(req({ model: 'too-long', messages: [] }));
    expect(r1.statusCode).toBe(400);
    expect(r1.headers['x-amzn-errortype']).toBe('ValidationException:http://internal');
    expect(JSON.parse(await drain(r1.body))).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'capability_rejected: prompt_too_long' },
    });
    const r2 = await adapter.forward(req({ model: 'throttle', messages: [] }));
    expect(r2.statusCode).toBe(429);
    expect(r2.headers['retry-after']).toBe('3');
    expect(JSON.parse(await drain(r2.body))).toMatchObject({ error: { type: 'rate_limit_error' } });
    // Other wording stays verbatim so Claude Code's own matches (e.g. "Extra inputs are
    // not permitted") keep working.
    const r3 = await adapter.forward(req({ model: 'other', messages: [] }));
    expect(JSON.parse(await drain(r3.body))).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'extra_field: Extra inputs are not permitted',
      },
    });
    await up.close();
  });

  it('count_tokens goes to CountTokens with the InvokeModel body and answers { input_tokens }', async () => {
    const up = await mock((c, res) => {
      if (c.path.endsWith('/count-tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"inputTokens":42}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const adapter = new BedrockAdapter({ baseUrl: up.url });
    const r = await adapter.countTokens(
      req(
        { model: 'anthropic.claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
        { 'anthropic-beta': 'b1' },
      ),
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(await drain(r.body))).toEqual({ input_tokens: 42 });
    expect(up.captured[0]!.path).toBe('/model/anthropic.claude-sonnet-5-5/count-tokens');
    const sent = JSON.parse(up.captured[0]!.body) as { input: { invokeModel: { body: string } } };
    const inner = JSON.parse(sent.input.invokeModel.body) as Record<string, unknown>;
    expect(inner['model']).toBeUndefined();
    expect(inner['anthropic_version']).toBe('bedrock-2023-05-31');
    expect(inner['anthropic_beta']).toEqual(['b1']);
    await up.close();
  });

  it('synthesizes ping events during a pause once the stream has started, and stops at the end', async () => {
    const up = new (await import('node:stream')).PassThrough();
    const out = bedrockToSse(up, { pingIntervalMs: 15 });
    const seen: string[] = [];
    out.on('data', (c: Buffer) => seen.push(c.toString('utf8')));
    // Silence BEFORE the first frame: no pings (pre-first-byte is the headers timeout's job).
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.join('')).not.toContain('event: ping');
    up.write(
      chunkFrame({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }),
    );
    await new Promise((r) => setTimeout(r, 70)); // a pause: ≥3 ping intervals
    const pingsDuringPause = seen.join('').split('event: ping').length - 1;
    expect(pingsDuringPause).toBeGreaterThanOrEqual(2);
    expect(seen.join('')).toContain('data: {"type":"ping"}');
    up.write(chunkFrame({ type: 'message_stop' }));
    up.end();
    await new Promise<void>((r) => out.on('end', () => r()));
    const total = seen.join('');
    const afterStop = total.slice(total.indexOf('event: message_stop'));
    expect(afterStop).not.toContain('event: ping');
    await new Promise((r) => setTimeout(r, 40)); // nothing after the end either
    expect(seen.join('')).toBe(total);
  });

  it('stops synthesizing pings after pingMaxIdleMs of silence so a hang reaches the watchdog', async () => {
    const up = new (await import('node:stream')).PassThrough();
    const out = bedrockToSse(up, { pingIntervalMs: 20, pingMaxIdleMs: 120 });
    const seen: string[] = [];
    out.on('data', (c: Buffer) => seen.push(c.toString('utf8')));
    up.write(chunkFrame({ type: 'message_start', message: { id: 'm' } }));
    const count = () => seen.join('').split('event: ping').length - 1;
    // Generous bounds (timers slip under a loaded test runner): some pings during the
    // idle budget, never more than fit in it…
    await new Promise((r) => setTimeout(r, 300));
    const afterBudget = count();
    expect(afterBudget).toBeGreaterThanOrEqual(1);
    expect(afterBudget).toBeLessThanOrEqual(7);
    // …and NONE once the idle budget is spent: the hang is now visible upstream.
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(afterBudget);
    up.destroy();
  });
});
