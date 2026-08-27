import { type SSEEvent, SSEParser } from './sse';

/** A windowed text transform (e.g. the guardrails StreamingRedactor). `push`
 *  returns the text safe to emit now (possibly redacted, possibly less than the
 *  input while a match forms); `flush` returns any held tail at stream end. */
export interface TextTransform {
  push(text: string): string;
  flush(): string;
}

function frameTextDelta(index: number, text: string): string {
  // Re-stringify the whole delta so quotes/backslashes/newlines in the transformed
  // text (e.g. a <<REDACTED_X>> placeholder) stay JSON-escaped; SSE frames
  // self-delimit, so the changed byte length is safe.
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })}\n\n`;
}

function reframe(ev: SSEEvent): string {
  return `${ev.event ? `event: ${ev.event}\n` : ''}data: ${ev.data}\n\n`;
}

function isTextDelta(parsed: Record<string, unknown>): boolean {
  const delta = parsed['delta'];
  return (
    !!delta &&
    typeof delta === 'object' &&
    (delta as Record<string, unknown>)['type'] === 'text_delta' &&
    typeof (delta as Record<string, unknown>)['text'] === 'string'
  );
}

/**
 * Applies a logical-text transform to the assistant TEXT of an Anthropic-canonical
 * SSE stream (M17). It parses the stream, runs the injected transform over the
 * `text` of every `content_block_delta`/`text_delta`, re-frames the transformed
 * text (preserving `index`, dropping a frame that redacts to empty), flushes the
 * transform's held tail before each structural block-end (and at `flush()` for a
 * truncated stream), and passes every OTHER event — `message_start`,
 * `content_block_start`, `ping`, `thinking_delta`, `signature_delta`,
 * `input_json_delta`, the usage-bearing `message_delta` — through verbatim.
 *
 * Text is the only thing rewritten, so metering (which reads the original frames
 * via a separate parser) and provider-affine artifacts (thinking signatures) are
 * untouched. v1 assumes a single text content block (the common chat shape).
 */
export class AnthropicSseRewriter {
  private readonly parser = new SSEParser();
  private lastTextIndex = 0;

  constructor(private readonly transform: TextTransform) {}

  /** Symmetry with {@link OpenAiSseRewriter}: the Anthropic stream is single-block,
   *  so this rewriter never fails closed on its own. */
  get failClosed(): boolean {
    return false;
  }

  push(chunk: string): string {
    let out = '';
    for (const ev of this.parser.push(chunk)) out += this.rewrite(ev);
    return out;
  }

  /** Flush the transform's held tail at stream end (covers a truncated stream that
   *  never delivered content_block_stop / message_stop). */
  flush(): string {
    return this.flushTransform();
  }

  private rewrite(ev: SSEEvent): string {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return reframe(ev); // not JSON we understand — pass through
    }
    const type = parsed['type'];

    if (type === 'content_block_delta' && isTextDelta(parsed)) {
      const index =
        typeof parsed['index'] === 'number' ? (parsed['index'] as number) : this.lastTextIndex;
      this.lastTextIndex = index;
      const text = (parsed['delta'] as Record<string, unknown>)['text'] as string;
      const emitted = this.transform.push(text);
      return emitted ? frameTextDelta(index, emitted) : '';
    }

    // A structural end of the text block: flush the transform's held tail first,
    // then pass the structural frame. flushTransform is empty once drained, so
    // calling it on every block-end is safe (incl. multi-block streams).
    if (type === 'content_block_stop' || type === 'message_delta' || type === 'message_stop') {
      return this.flushTransform() + reframe(ev);
    }

    return reframe(ev);
  }

  private flushTransform(): string {
    const tail = this.transform.flush();
    return tail ? frameTextDelta(this.lastTextIndex, tail) : '';
  }
}

/** The `id`/`object`/`created`/`model` envelope of an OpenAI chunk, captured so a
 *  synthetic content chunk (carrying the transform's flushed tail) looks native. */
type ChunkEnvelope = Partial<Record<'id' | 'object' | 'created' | 'model', unknown>>;

/**
 * The OpenAI-`chat.completions` analogue of {@link AnthropicSseRewriter} (M17,
 * non-Anthropic re-framing). It applies the injected transform to the assistant
 * TEXT at `choices[].delta.content` of every streamed `chat.completion.chunk`,
 * re-frames the transformed chunk (eventless `data: {json}\n\n`, dropping a chunk
 * whose only payload redacted to empty), and passes every other frame — the
 * `role` opener, `finish_reason` chunk, the `choices:[]` usage chunk, `[DONE]`,
 * and anything non-JSON — through verbatim.
 *
 * Because the transform is windowed it always holds a tail; that tail is flushed
 * as a SYNTHETIC content chunk immediately BEFORE the first terminal-ish frame
 * (a `finish_reason` chunk, the usage chunk, or `[DONE]`), or folded into a chunk
 * that carries content AND `finish_reason` together — so redacted text is never
 * lost or reordered. Usage lives in a `choices:[]` frame (no `delta.content`), so
 * metering — which reads the pre-rewrite bytes via a separate parser — is
 * untouched. `reasoning_content` and other non-`content` delta fields pass through
 * unmodified (like Anthropic thinking). Single-choice (`n=1`) only: a stream that
 * carries content on a second choice index sets {@link failClosed} (a single
 * windowed transform cannot enforce interleaved choices without misattributing
 * text), and the caller terminates rather than emit corrupted output.
 */
export class OpenAiSseRewriter {
  private readonly parser = new SSEParser();
  private envelope: ChunkEnvelope = {};
  private firstContentIndex: number | undefined;
  private _failClosed = false;

  constructor(private readonly transform: TextTransform) {}

  /** Set when the stream carries content on more than one choice index (`n>1`).
   *  A single windowed transform can't enforce interleaved choices without
   *  misattributing text between them, so the caller terminates the stream rather
   *  than emit corrupted output. Always `false` for a single-choice stream. */
  get failClosed(): boolean {
    return this._failClosed;
  }

  push(chunk: string): string {
    if (this._failClosed) return '';
    let out = '';
    for (const ev of this.parser.push(chunk)) {
      out += this.rewrite(ev);
      if (this._failClosed) break; // n>1 detected mid-chunk — stop (no corrupt emit)
    }
    return out;
  }

  /** Flush the transform's held tail at stream end (covers a truncated stream that
   *  never delivered a finish/usage chunk or `[DONE]`). */
  flush(): string {
    if (this._failClosed) return '';
    return this.synthFromTail();
  }

  private rewrite(ev: SSEEvent): string {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      // `[DONE]` and any non-JSON: flush the held tail first, then pass through.
      return this.synthFromTail() + reframe(ev);
    }
    const choices = parsed['choices'];
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(choices)) {
      return this.synthFromTail() + reframe(ev);
    }
    this.captureEnvelope(parsed);

    // Transform each choice's text delta. Track whether this chunk carried any
    // content, the (last) delta that did, and whether the emitted text is all empty.
    let hadContent = false;
    let anyEmitted = false;
    let onlyContentKeys = true;
    let contentDelta: Record<string, unknown> | undefined;
    let hasFinish = false;
    for (const c of choices) {
      if (!c || typeof c !== 'object') continue;
      const choice = c as Record<string, unknown>;
      if (choice['finish_reason'] != null) hasFinish = true;
      const delta = choice['delta'];
      if (!delta || typeof delta !== 'object') continue;
      const d = delta as Record<string, unknown>;
      for (const k of Object.keys(d)) if (k !== 'content') onlyContentKeys = false;
      if (typeof d['content'] === 'string') {
        const idx = typeof choice['index'] === 'number' ? (choice['index'] as number) : 0;
        if (this.firstContentIndex === undefined) this.firstContentIndex = idx;
        else if (idx !== this.firstContentIndex) {
          this._failClosed = true; // n>1: refuse rather than misattribute text
          return '';
        }
        hadContent = true;
        const emitted = this.transform.push(d['content'] as string);
        d['content'] = emitted;
        if (emitted) anyEmitted = true;
        contentDelta = d;
      }
    }
    const hasTerminal = hasFinish || parsed['usage'] != null;

    if (hasTerminal) {
      // Drain the window tail before the stream's tail-end. Fold it into this
      // chunk's own content when it carries some, else emit it as a synthetic
      // content chunk ahead of this terminal frame.
      const tail = this.transform.flush();
      if (tail) {
        if (hadContent && contentDelta) {
          contentDelta['content'] = String(contentDelta['content'] ?? '') + tail;
          anyEmitted = true;
        } else {
          return this.synthFrame(tail) + reframe({ event: ev.event, data: JSON.stringify(parsed) });
        }
      }
      return reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    // Non-terminal: a pure text-delta chunk that held everything back emits no
    // frame (mirrors the Anthropic rewriter). Never drop a chunk that also carries
    // a role opener / tool_calls / any non-content delta key.
    if (hadContent && !anyEmitted && onlyContentKeys) return '';
    return reframe({ event: ev.event, data: JSON.stringify(parsed) });
  }

  private captureEnvelope(parsed: Record<string, unknown>): void {
    for (const k of ['id', 'object', 'created', 'model'] as const) {
      if (this.envelope[k] === undefined && parsed[k] !== undefined) this.envelope[k] = parsed[k];
    }
  }

  /** Flush the transform's remaining tail as a synthetic chunk (empty if drained). */
  private synthFromTail(): string {
    const tail = this.transform.flush();
    return tail ? this.synthFrame(tail) : '';
  }

  private synthFrame(text: string): string {
    const chunk: Record<string, unknown> = {
      ...this.envelope,
      object: this.envelope['object'] ?? 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
}
