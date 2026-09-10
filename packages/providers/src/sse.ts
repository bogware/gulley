export interface SSEEvent {
  event?: string;
  data: string;
}

/** Raised when a single in-progress SSE event exceeds the parser's byte cap before
 *  an event boundary. Enforcing consumers (the M17/M18 rewriters) let this propagate
 *  so an un-inspectable oversized event fails the stream CLOSED rather than leaking
 *  bytes; the best-effort metering consumer uses `onOverflow: 'reset'` instead. */
export class SSEOverflowError extends Error {
  constructor(readonly limitBytes: number) {
    super(`SSE event exceeded ${limitBytes} bytes with no event boundary`);
    this.name = 'SSEOverflowError';
  }
}

export interface SSEParserOptions {
  /** Cap on the bytes held for ONE in-progress event (the unparsed line buffer plus
   *  the accumulated `data:` lines). Bounds per-stream memory: without it a buggy or
   *  hostile upstream that streams an enormous single line, or never terminates an
   *  event with a blank line, grows the parser to the full response size on the
   *  otherwise-never-buffer hot path. Default 8 MiB. */
  maxBufferBytes?: number;
  /** Overflow policy. 'throw' (default) raises {@link SSEOverflowError} so an enforcing
   *  rewriter fails CLOSED (the caller aborts the stream). 'reset' drops the pending
   *  event and resyncs to the next event boundary — for the metering parser, where
   *  losing one best-effort usage delta is acceptable and must NOT kill the stream. */
  onOverflow?: 'throw' | 'reset';
}

const DEFAULT_SSE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Incremental Server-Sent-Events parser. Feed arbitrary byte chunks (which may
 * split lines or events); it emits completed events. Comment lines (`: ping`
 * heartbeats) are ignored. Used for metering (raw bytes are forwarded to the client
 * untouched, so a parser bug can never corrupt the client stream) and, with the
 * default fail-closed overflow policy, inside the M17/M18 streaming enforcers.
 */
export class SSEParser {
  private buffer = '';
  private currentEvent: string | undefined = undefined;
  private dataLines: string[] = [];
  private dataBytes = 0; // running size of the accumulated data lines
  private dropping = false; // resync mode after a 'reset' overflow
  private readonly maxBufferBytes: number;
  private readonly onOverflow: 'throw' | 'reset';

  constructor(opts: SSEParserOptions = {}) {
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_SSE_MAX_BUFFER_BYTES;
    this.onOverflow = opts.onOverflow ?? 'throw';
  }

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const out: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (this.dropping) {
        // Resyncing after a 'reset' overflow: discard lines until the next boundary.
        if (line === '') this.dropping = false;
        continue;
      }
      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.currentEvent, data: this.dataLines.join('\n') });
        }
        this.currentEvent = undefined;
        this.dataLines = [];
        this.dataBytes = 0;
        continue;
      }
      if (line.startsWith(':')) continue; // heartbeat / comment
      if (line.startsWith('event:')) {
        this.currentEvent = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        const d = line.slice('data:'.length).replace(/^ /, '');
        this.dataLines.push(d);
        this.dataBytes += d.length + 1;
      }
      this.enforceLimit();
    }
    this.enforceLimit(); // an unterminated line that keeps growing without a newline
    return out;
  }

  /** Bound the in-progress event. On overflow either fail closed (throw) or, for the
   *  metering parser, drop the pending event and resync to the next boundary. */
  private enforceLimit(): void {
    if (this.buffer.length + this.dataBytes <= this.maxBufferBytes) return;
    if (this.onOverflow === 'throw') throw new SSEOverflowError(this.maxBufferBytes);
    this.buffer = '';
    this.currentEvent = undefined;
    this.dataLines = [];
    this.dataBytes = 0;
    this.dropping = true;
  }
}
