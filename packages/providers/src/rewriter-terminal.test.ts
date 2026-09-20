import { describe, expect, it } from 'vitest';
import {
  AnthropicSseRewriter,
  OpenAiSseRewriter,
  ResponsesSseRewriter,
  type TextTransform,
} from './sse-rewriter';

/** A transform that emits text up to (not including) the first "SECRET", then
 *  reports itself terminal — the shape of a StreamingRedactor under `block`. */
function blockingTransform(): TextTransform {
  let done = false;
  return {
    push(t) {
      if (done) return '';
      const i = t.indexOf('SECRET');
      if (i === -1) return t;
      done = true;
      return t.slice(0, i);
    },
    flush() {
      return '';
    },
    terminal: () => done,
  };
}

describe('SSE rewriters stop at a terminal transform (no [DONE]/message_stop after a block)', () => {
  it('Anthropic: the safe prefix is emitted, the finish/stop frames are not', () => {
    const r = new AnthropicSseRewriter(blockingTransform());
    const out =
      r.push(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok SECRET more"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ) + r.flush();
    expect(out).toContain('"text":"ok "');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('message_stop');
    expect(out).not.toContain('content_block_stop');
    expect(r.failClosed).toBe(true);
  });

  it('OpenAI chat: the safe prefix is emitted as a bare content chunk; finish_reason and [DONE] are withheld', () => {
    const r = new OpenAiSseRewriter(blockingTransform());
    const out =
      r.push(
        'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok SECRET"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      ) + r.flush();
    expect(out).toContain('"content":"ok "');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('finish_reason":"stop"');
    expect(out).not.toContain('[DONE]');
    expect(r.failClosed).toBe(true);
  });

  it('Responses: no output_text.done / completed echo follows a block', () => {
    const r = new ResponsesSseRewriter(blockingTransform());
    const out =
      r.push(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"i","output_index":0,"content_index":0,"delta":"ok SECRET"}\n\n' +
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"i","output_index":0,"content_index":0,"text":"ok SECRET"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok SECRET"}]}]}}\n\n',
      ) + r.flush();
    expect(out).toContain('"delta":"ok "');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('response.completed');
    expect(out).not.toContain('output_text.done');
    expect(r.failClosed).toBe(true);
  });
});
