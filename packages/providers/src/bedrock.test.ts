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
