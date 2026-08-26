import { PassThrough, type Readable } from 'node:stream';

/**
 * Decoder for the AWS `application/vnd.amazon.eventstream` framing that Bedrock's
 * invoke-with-response-stream returns. Each frame:
 *   [totalLen u32][headersLen u32][preludeCrc u32][headers][payload][msgCrc u32]
 * For Claude on Bedrock, each `chunk` event's payload is `{"bytes": <base64>}`
 * where the decoded bytes are a native Anthropic SSE event object. We re-emit
 * those as real `text/event-stream` so the rest of the pipeline is identical to
 * the native Anthropic path. CRCs are not validated (transport already is).
 */
export interface EventstreamFrame {
  headers: Record<string, string>;
  payload: Buffer;
}

/** AWS caps a single eventstream message at 16 MiB. A frame declaring more than
 *  that is corrupt or hostile — and without this bound the parser would buffer
 *  toward that declared length unboundedly (`this.buf` never satisfies
 *  `length < total`), an OOM/DoS vector on a malicious or truncated upstream. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Minimum frame: 12-byte prelude (totalLen, headersLen, preludeCrc) + 4-byte CRC. */
const MIN_FRAME_BYTES = 16;

export class EventstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventstreamError';
  }
}

export class EventstreamParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): EventstreamFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: EventstreamFrame[] = [];
    while (this.buf.length >= 4) {
      const total = this.buf.readUInt32BE(0);
      // Validate the declared length BEFORE waiting for that many bytes, so a
      // bogus multi-GB length is rejected immediately instead of buffering.
      if (total < MIN_FRAME_BYTES || total > MAX_FRAME_BYTES) {
        throw new EventstreamError(`invalid eventstream frame length: ${total}`);
      }
      if (this.buf.length < total) break; // legitimate partial frame — await more
      const frame = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      out.push(parseFrame(frame));
    }
    return out;
  }
}

function parseFrame(frame: Buffer): EventstreamFrame {
  const headersLen = frame.readUInt32BE(4);
  const headersStart = 12;
  const headersEnd = headersStart + headersLen;
  // Headers must fit between the 12-byte prelude and the trailing 4-byte CRC;
  // an out-of-range headersLen would otherwise make the payload slice negative.
  if (headersLen > frame.length || headersEnd > frame.length - 4) {
    throw new EventstreamError(`corrupt eventstream frame: headers length ${headersLen}`);
  }
  return {
    headers: parseHeaders(frame.subarray(headersStart, headersEnd)),
    payload: frame.subarray(headersEnd, frame.length - 4),
  };
}

function parseHeaders(buf: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let o = 0;
  while (o < buf.length) {
    const nameLen = buf.readUInt8(o);
    o += 1;
    const name = buf.toString('utf8', o, o + nameLen);
    o += nameLen;
    const type = buf.readUInt8(o);
    o += 1;
    switch (type) {
      case 0: // bool true
      case 1: // bool false
        break;
      case 2: // byte
        o += 1;
        break;
      case 3: // short
        o += 2;
        break;
      case 4: // integer
        o += 4;
        break;
      case 5: // long
        o += 8;
        break;
      case 6: {
        // bytes
        const l = buf.readUInt16BE(o);
        o += 2 + l;
        break;
      }
      case 7: {
        // string — the only type we capture (:event-type, :message-type, ...)
        const l = buf.readUInt16BE(o);
        o += 2;
        headers[name] = buf.toString('utf8', o, o + l);
        o += l;
        break;
      }
      case 8: // timestamp
        o += 8;
        break;
      case 9: // uuid
        o += 16;
        break;
      default:
        return headers; // unknown type — cannot safely advance
    }
  }
  return headers;
}

/** Wrap a Bedrock eventstream response body into an Anthropic-SSE Readable. */
export function bedrockToSse(upstream: Readable): Readable {
  const out = new PassThrough();
  const parser = new EventstreamParser();

  upstream.on('data', (chunk: Buffer) => {
    let frames: EventstreamFrame[];
    try {
      frames = parser.push(chunk);
    } catch (err) {
      // A bad frame length/bounds desynchronizes the byte stream — there is no
      // safe resync point, and silently returning would spin on the same bytes
      // (and keep buffering). Terminate both ends cleanly instead.
      out.destroy(err as Error);
      upstream.destroy();
      return;
    }
    for (const f of frames) {
      const messageType = f.headers[':message-type'];
      const eventType = f.headers[':event-type'];
      if (messageType === 'event' && eventType === 'chunk') {
        try {
          const wrapper = JSON.parse(f.payload.toString('utf8')) as { bytes?: string };
          if (!wrapper.bytes) continue;
          const decoded = Buffer.from(wrapper.bytes, 'base64').toString('utf8');
          const evt = JSON.parse(decoded) as { type?: string };
          const name = evt.type ?? 'message';
          out.write(`event: ${name}\ndata: ${decoded}\n\n`);
        } catch {
          /* skip a malformed chunk */
        }
      } else if (messageType === 'exception' || (eventType && eventType.endsWith('Exception'))) {
        out.write(`event: error\ndata: ${f.payload.toString('utf8')}\n\n`);
      }
    }
  });
  upstream.on('end', () => out.end());
  upstream.on('error', (err: Error) => out.destroy(err));

  return out;
}
