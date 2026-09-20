import { type SSEEvent, SSEParser } from './sse';

/** A windowed text transform (e.g. the guardrails StreamingRedactor). `push`
 *  returns the text safe to emit now (possibly redacted, possibly less than the
 *  input while a match forms); `flush` returns any held tail at stream end. */
export interface TextTransform {
  push(text: string): string;
  flush(): string;
  /** Optional: true once the transform has blocked / failed closed. A rewriter then
   *  emits the safe prefix it was just handed and NOTHING after it — no structural
   *  terminal (`content_block_stop`/`message_stop`/`[DONE]`/`response.completed`),
   *  so the caller's terminal error frame is the last thing the client sees. */
  terminal?(): boolean;
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
 * untouched. Single text-block only: a `text_delta` on a SECOND content-block index
 * sets {@link failClosed} (one windowed transform cannot enforce two interleaved
 * text blocks without mis-attributing a redacted tail) and the caller terminates.
 * A `tool_use`/`thinking` block on another index is fine — it carries no text_delta.
 */
export class AnthropicSseRewriter {
  private readonly parser = new SSEParser();
  private lastTextIndex = 0;
  private firstTextIndex: number | undefined;
  private _failClosed = false;

  constructor(private readonly transform: TextTransform) {}

  /** Symmetry with {@link OpenAiSseRewriter}: set when a second TEXT content-block
   *  index appears (multi-text stream), which this single-transform rewriter cannot
   *  enforce without mis-attributing text; the caller terminates rather than corrupt. */
  get failClosed(): boolean {
    return this._failClosed;
  }

  push(chunk: string): string {
    if (this._failClosed) return '';
    let out = '';
    for (const ev of this.parser.push(chunk)) {
      out += this.rewrite(ev);
      if (this._failClosed) break; // second text block detected — stop (no corrupt emit)
    }
    return out;
  }

  /** Flush the transform's held tail at stream end (covers a truncated stream that
   *  never delivered content_block_stop / message_stop). */
  flush(): string {
    if (this._failClosed) return '';
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
      if (this.firstTextIndex === undefined) this.firstTextIndex = index;
      else if (index !== this.firstTextIndex) {
        this._failClosed = true; // a second text block — refuse rather than mis-attribute
        return '';
      }
      this.lastTextIndex = index;
      const text = (parsed['delta'] as Record<string, unknown>)['text'] as string;
      const emitted = this.transform.push(text);
      if (this.transform.terminal?.()) {
        this._failClosed = true; // emit the safe prefix, then nothing more
        return emitted ? frameTextDelta(index, emitted) : '';
      }
      return emitted ? frameTextDelta(index, emitted) : '';
    }

    // A structural end of the text block: flush the transform's held tail first,
    // then pass the structural frame. flushTransform is empty once drained, so
    // calling it on every block-end is safe (incl. multi-block streams).
    if (type === 'content_block_stop' || type === 'message_delta' || type === 'message_stop') {
      const tail = this.flushTransform();
      if (this.transform.terminal?.()) {
        this._failClosed = true; // the flush hit a block: no structural frame after it
        return tail;
      }
      return tail + reframe(ev);
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
 * unmodified (like Anthropic thinking); per-token `logprobs` (which echo the RAW
 * text token-by-token) are STRIPPED so they can't reconstruct the redacted text.
 * Single-choice (`n=1`) only: a stream that
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
      const tail = this.synthFromTail();
      if (this.transform.terminal?.()) {
        this._failClosed = true; // never relay [DONE] after a block
        return tail;
      }
      return tail + reframe(ev);
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
      // Per-token logprobs (`logprobs.content[].token` / `top_logprobs`) echo the RAW
      // assistant text token-by-token — an enforcement bypass. Strip them.
      delete choice['logprobs'];
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
        if (this.transform.terminal?.()) {
          // Blocked mid-chunk: emit only the safe prefix as a bare content chunk,
          // never this chunk's finish_reason/usage or anything after it.
          this._failClosed = true;
          return emitted ? this.synthFrame(emitted) : '';
        }
      }
    }
    const hasTerminal = hasFinish || parsed['usage'] != null;

    if (hasTerminal) {
      // Drain the window tail before the stream's tail-end. Fold it into this
      // chunk's own content when it carries some, else emit it as a synthetic
      // content chunk ahead of this terminal frame.
      const tail = this.transform.flush();
      if (this.transform.terminal?.()) {
        this._failClosed = true; // the flush hit a block: safe tail only, no finish/[DONE]
        return tail ? this.synthFrame(tail) : '';
      }
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

/** The item envelope of a Responses `output_text` part, captured so a synthetic
 *  tail delta looks native. */
type ResponsesEnvelope = Partial<Record<'item_id' | 'output_index' | 'content_index', unknown>>;

/**
 * The OpenAI `/v1/responses` analogue of {@link OpenAiSseRewriter} (M22 B). It
 * applies the injected transform to the assistant TEXT of a Responses stream —
 * carried in `response.output_text.delta` `delta` fields — and, crucially, keeps
 * EVERY echo consistent. The full assistant text is re-emitted in
 * `response.output_text.done` (`text`), `response.content_part.done` (`part.text`),
 * `response.output_item.done` (`item.content[].text`), and the terminal
 * `response.completed`/`.incomplete`/`.failed` (`response.output[].content[].text`) —
 * most SDKs build the final message from one of these, so a rewriter that redacted
 * only the deltas would LEAK the un-redacted text. Because the windowed transform is
 * stateful, the echoes CANNOT be re-transformed; instead this substitutes the
 * ALREADY-transformed accumulator (`acc`) into every echo field. Per-token
 * `logprobs` (which spell out the RAW text token-by-token) are STRIPPED from every
 * rewritten frame — they cannot be redacted and would otherwise reconstruct the
 * secret verbatim.
 *
 * All non-text events — `response.created`/`in_progress`, `output_item`/`content_part`
 * `.added`, `response.reasoning_summary_text.delta` (thinking),
 * `response.function_call_arguments.delta`/`.done` (tool args), `error`, and any
 * non-JSON — pass through verbatim. Usage lives in `response.completed.response.usage`,
 * left byte-untouched (metering reads it via a separate parser). Single output_text
 * part only: a second `(output_index, content_index)` output_text pair sets
 * {@link failClosed} and the caller terminates.
 */
export class ResponsesSseRewriter {
  private readonly parser = new SSEParser();
  private acc = ''; // the transformed text emitted so far, for echo substitution
  private envelope: ResponsesEnvelope = {};
  private firstPart: string | undefined; // `${output_index}:${content_index}` of the 1st part
  private _failClosed = false;

  constructor(private readonly transform: TextTransform) {}

  /** Set when a second output_text part appears — a single windowed transform can't
   *  enforce two without mis-attributing its held tail; the caller terminates. */
  get failClosed(): boolean {
    return this._failClosed;
  }

  push(chunk: string): string {
    if (this._failClosed) return '';
    let out = '';
    for (const ev of this.parser.push(chunk)) {
      out += this.rewrite(ev);
      if (this._failClosed) break;
    }
    return out;
  }

  /** Flush the transform's held tail at stream end (covers a truncated stream that
   *  never delivered output_text.done / response.completed). */
  flush(): string {
    if (this._failClosed) return '';
    const tail = this.transform.flush();
    if (!tail) return '';
    this.acc += tail;
    return this.synthDelta(tail);
  }

  private rewrite(ev: SSEEvent): string {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return reframe(ev); // non-JSON (rare) — pass through
    }
    const type = parsed['type'];

    if (type === 'response.output_text.delta') {
      const key = `${parsed['output_index']}:${parsed['content_index']}`;
      if (this.firstPart === undefined) {
        this.firstPart = key;
        for (const k of ['item_id', 'output_index', 'content_index'] as const)
          if (parsed[k] !== undefined) this.envelope[k] = parsed[k];
      } else if (key !== this.firstPart) {
        this._failClosed = true; // a second output_text part — refuse rather than mis-attribute
        return '';
      }
      const delta = typeof parsed['delta'] === 'string' ? (parsed['delta'] as string) : '';
      const emitted = this.transform.push(delta);
      this.acc += emitted;
      delete parsed['logprobs']; // per-token logprobs echo the RAW text — strip them
      if (this.transform.terminal?.()) {
        this._failClosed = true; // safe prefix only; no echoes / completion after a block
        if (!emitted) return '';
        parsed['delta'] = emitted;
        return reframe({ event: ev.event, data: JSON.stringify(parsed) });
      }
      if (!emitted) return ''; // held back this window — drop the frame
      parsed['delta'] = emitted;
      return reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    // Terminal echo of the part text: flush the held tail (emit it as a synthetic
    // delta for delta-only consumers), then substitute the full accumulator. If we
    // never saw a delta for this part, the enforcer never windowed this text, so
    // substituting the (empty) accumulator would blank it and passing it through
    // would bypass enforcement — fail closed instead (a non-conformant upstream).
    if (type === 'response.output_text.done') {
      if (this.firstPart === undefined && String(parsed['text'] ?? '') !== '')
        return this.failClose();
      const pre = this.drainTail();
      if (this._failClosed) return pre;
      parsed['text'] = this.acc;
      delete parsed['logprobs'];
      return pre + reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    if (type === 'response.content_part.done') {
      const part = parsed['part'] as Record<string, unknown> | undefined;
      if (part && part['type'] === 'output_text') {
        if (this.firstPart === undefined && String(part['text'] ?? '') !== '')
          return this.failClose();
        part['text'] = this.acc;
        delete part['logprobs'];
      }
      return reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    // The fully-materialized message item, echoed just before response.completed —
    // its content[].text carries the whole assistant text (the official SDK builds
    // response.output from it), so it must be scrubbed like the other echoes.
    if (type === 'response.output_item.done') {
      const pre = this.drainTail();
      if (this._failClosed) return pre;
      const item = parsed['item'] as Record<string, unknown> | undefined;
      if (!this.substituteContent(item?.['content'])) return this.failClose();
      return pre + reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.failed'
    ) {
      const pre = this.drainTail(); // in case there was no output_text.done
      if (this._failClosed) return pre;
      if (!this.substituteCompleted(parsed)) return this.failClose();
      return pre + reframe({ event: ev.event, data: JSON.stringify(parsed) });
    }

    return reframe(ev); // every other event passes through verbatim
  }

  private failClose(): string {
    this._failClosed = true;
    return '';
  }

  /** Flush the transform tail once, folding it into the accumulator and emitting it
   *  as a synthetic delta (idempotent — empty once drained). */
  private drainTail(): string {
    const tail = this.transform.flush();
    if (this.transform.terminal?.()) this._failClosed = true; // caller emits no echo after this
    if (!tail) return '';
    this.acc += tail;
    return this.synthDelta(tail);
  }

  /** Overwrite every output_text `.text` in a terminal response object with the
   *  accumulator (and strip its logprobs), leaving usage + every sibling byte-intact.
   *  Returns false (→ fail closed) if an echo carries text we never windowed. */
  private substituteCompleted(parsed: Record<string, unknown>): boolean {
    const response = parsed['response'];
    if (!response || typeof response !== 'object') return true;
    const output = (response as Record<string, unknown>)['output'];
    if (!Array.isArray(output)) return true;
    for (const item of output) {
      if (!this.substituteContent((item as Record<string, unknown>)?.['content'])) return false;
    }
    return true;
  }

  /** Scrub one item's content[] blocks: each output_text block's `text` becomes the
   *  accumulator and its per-token `logprobs` are stripped. Returns false if a block
   *  carries text that was never windowed via a delta (→ the caller fails closed). */
  private substituteContent(content: unknown): boolean {
    if (!Array.isArray(content)) return true;
    for (const c of content) {
      const block = c as Record<string, unknown>;
      if (block?.['type'] !== 'output_text') continue;
      if (this.firstPart === undefined && String(block['text'] ?? '') !== '') return false;
      block['text'] = this.acc;
      delete block['logprobs'];
    }
    return true;
  }

  /** A synthetic, event-named `response.output_text.delta` carrying `text`. */
  private synthDelta(text: string): string {
    const frame: Record<string, unknown> = {
      type: 'response.output_text.delta',
      ...this.envelope,
      delta: text,
    };
    return `event: response.output_text.delta\ndata: ${JSON.stringify(frame)}\n\n`;
  }
}
