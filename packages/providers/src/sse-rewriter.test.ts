import { describe, expect, it } from 'vitest';
import { SSEParser } from './sse';
import { AnthropicSseRewriter, type TextTransform } from './sse-rewriter';

type Delta = { type: string; text?: string; thinking?: string };
type Ev = { type: string; index?: number; delta?: Delta };

const frame = (event: string, obj: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
const textDelta = (index: number, text: string): string =>
  frame('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });

const parse = (sse: string): Array<{ event?: string; obj: Ev }> =>
  new SSEParser().push(sse).map((e) => ({ event: e.event, obj: JSON.parse(e.data) as Ev }));

const identity: TextTransform = { push: (t) => t, flush: () => '' };

describe('AnthropicSseRewriter', () => {
  it('passes non-text events (message_start, content_block_start, thinking_delta) through verbatim', () => {
    const r = new AnthropicSseRewriter(identity);
    const input =
      frame('message_start', { type: 'message_start', message: { id: 'm' } }) +
      frame('content_block_start', { type: 'content_block_start', index: 0 }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      });
    const events = parse(r.push(input) + r.flush());
    expect(events.map((e) => e.obj.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
    ]);
    expect(events[2]?.obj.delta?.type).toBe('thinking_delta'); // not touched
  });

  it('applies the transform to text_delta content only', () => {
    const upper: TextTransform = { push: (t) => t.toUpperCase(), flush: () => '' };
    const out = new AnthropicSseRewriter(upper).push(textDelta(0, 'hello world'));
    expect(parse(out)[0]?.obj.delta?.text).toBe('HELLO WORLD');
  });

  it('drops a delta that transforms to empty, and flushes a held tail before content_block_stop', () => {
    let held = '';
    const holder: TextTransform = {
      push: (t) => {
        held += t;
        return '';
      },
      flush: () => {
        const o = held;
        held = '';
        return o;
      },
    };
    const r = new AnthropicSseRewriter(holder);
    expect(parse(r.push(textDelta(0, 'secret bits')))).toEqual([]); // held ⇒ nothing emitted yet
    const events = parse(
      r.push(frame('content_block_stop', { type: 'content_block_stop', index: 0 })),
    );
    expect(events[0]?.obj.delta?.text).toBe('secret bits'); // flushed tail as a final text_delta
    expect(events[1]?.obj.type).toBe('content_block_stop');
  });

  it('re-stringifies so a placeholder with quotes/newlines stays valid JSON', () => {
    const weird: TextTransform = { push: () => '<<REDACTED_"X"\n>>', flush: () => '' };
    const out = new AnthropicSseRewriter(weird).push(textDelta(0, 'anything'));
    expect(parse(out)[0]?.obj.delta?.text).toBe('<<REDACTED_"X"\n>>');
  });

  it('reassembles and transforms text split across two content_block_delta events', () => {
    let buf = '';
    const redactSecret: TextTransform = {
      push: (t) => {
        buf += t;
        if (buf.length < 12) return '';
        const out = buf.replace(/SECRET/g, '[R]');
        buf = '';
        return out;
      },
      flush: () => {
        const out = buf.replace(/SECRET/g, '[R]');
        buf = '';
        return out;
      },
    };
    const r = new AnthropicSseRewriter(redactSecret);
    let out = r.push(textDelta(0, 'my SEC'));
    out += r.push(textDelta(0, 'RET here'));
    out += r.flush();
    const text = parse(out)
      .filter((e) => e.obj.type === 'content_block_delta')
      .map((e) => e.obj.delta?.text ?? '')
      .join('');
    expect(text).toBe('my [R] here');
  });
});
