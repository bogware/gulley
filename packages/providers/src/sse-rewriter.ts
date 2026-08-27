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
