import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bedrockToSse, EventstreamError, EventstreamParser } from './bedrock-eventstream';

/** Encode a single AWS eventstream frame the way Bedrock frames a `chunk` event. */
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
    b.writeUInt8(7, o); // header value type 7 = string
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
  f.writeUInt32BE(0, 8); // prelude CRC (not validated)
  hbuf.copy(f, 12);
  payload.copy(f, 12 + hbuf.length);
  f.writeUInt32BE(0, total - 4); // message CRC (not validated)
  return f;
}

function chunkFrame(anthropicEvent: object): Buffer {
  const inner = Buffer.from(JSON.stringify(anthropicEvent), 'utf8').toString('base64');
  const payload = Buffer.from(JSON.stringify({ bytes: inner }), 'utf8');
  return encodeFrame({ ':message-type': 'event', ':event-type': 'chunk' }, payload);
}

describe('EventstreamParser', () => {
  it('reassembles a frame delivered one byte at a time (prelude/frame split)', () => {
    const frame = chunkFrame({ type: 'message_start' });
    const parser = new EventstreamParser();
    const seen = [];
    for (let i = 0; i < frame.length; i++) {
      const emitted = parser.push(frame.subarray(i, i + 1));
      // Nothing may emit until the final byte completes the frame.
      if (i < frame.length - 1) expect(emitted).toHaveLength(0);
      seen.push(...emitted);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers[':event-type']).toBe('chunk');
  });

  it('rejects a frame declaring a size beyond the 16 MiB cap (no unbounded buffering)', () => {
    const parser = new EventstreamParser();
    const evil = Buffer.alloc(8);
    evil.writeUInt32BE(0xffffffff, 0); // ~4 GB declared length
    expect(() => parser.push(evil)).toThrow(EventstreamError);
  });

  it('rejects a frame whose declared length is below the 16-byte minimum', () => {
    const parser = new EventstreamParser();
    const runt = Buffer.alloc(4);
    runt.writeUInt32BE(8, 0);
    expect(() => parser.push(runt)).toThrow(EventstreamError);
  });

  it('rejects a frame whose headers length overruns the frame bounds', () => {
    const parser = new EventstreamParser();
    const frame = chunkFrame({ type: 'ping' });
    frame.writeUInt32BE(frame.length, 4); // headersLen == total → payload slice goes negative
    expect(() => parser.push(frame)).toThrow(EventstreamError);
  });
});

describe('bedrockToSse', () => {
  it('re-emits chunk frames as native Anthropic SSE', async () => {
    const upstream = new PassThrough();
    const sse = bedrockToSse(upstream);
    const chunks: Buffer[] = [];
    sse.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((res) => sse.on('end', res));

    upstream.write(chunkFrame({ type: 'message_start', message: { id: 'msg_1' } }));
    upstream.end();
    await done;

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('event: message_start');
    expect(text).toContain('"id":"msg_1"');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('destroys the stream on a corrupt frame instead of spinning', async () => {
    const upstream = new PassThrough();
    const sse = bedrockToSse(upstream);
    const err = await new Promise<Error>((resolve) => {
      sse.on('error', resolve);
      sse.resume();
      const evil = Buffer.alloc(8);
      evil.writeUInt32BE(0xffffffff, 0);
      upstream.write(evil);
    });
    expect(err).toBeInstanceOf(EventstreamError);
  });
});
