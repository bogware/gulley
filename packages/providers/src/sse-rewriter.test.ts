import { describe, expect, it } from 'vitest';
import { SSEParser } from './sse';
import { AnthropicSseRewriter, OpenAiSseRewriter, type TextTransform } from './sse-rewriter';

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

type OaChunk = {
  choices?: Array<{
    index?: number;
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
};

const oaChunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const contentChunk = (text: string): string =>
  oaChunk({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'gpt',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
const finishChunk = (): string =>
  oaChunk({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'gpt',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
const usageChunk = (): string =>
  oaChunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
const DONE = 'data: [DONE]\n\n';

const datas = (sse: string): string[] => new SSEParser().push(sse).map((e) => e.data);
const contentOf = (sse: string): string =>
  datas(sse)
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d) as OaChunk)
    .flatMap((o) => (o.choices ?? []).map((c) => c.delta?.content))
    .filter((x): x is string => typeof x === 'string')
    .join('');

describe('OpenAiSseRewriter', () => {
  it('passes the role opener, finish chunk, usage chunk, and [DONE] through', () => {
    const opener = oaChunk({
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    const r = new OpenAiSseRewriter(identity);
    const out =
      r.push(opener + contentChunk('Hello') + finishChunk() + usageChunk() + DONE) + r.flush();
    expect(contentOf(out)).toBe('Hello');
    expect(datas(out)).toContain('[DONE]');
    expect(out).toContain('"usage"'); // usage frame preserved for metering-parity clients
    expect(out).toContain('"finish_reason":"stop"');
  });

  it('applies the transform to delta.content only', () => {
    const upper: TextTransform = { push: (t) => t.toUpperCase(), flush: () => '' };
    const out = new OpenAiSseRewriter(upper).push(contentChunk('hello world'));
    const o = JSON.parse(datas(out)[0] ?? '{}') as OaChunk;
    expect(o.choices?.[0]?.delta?.content).toBe('HELLO WORLD');
  });

  it('drops a fully-held content chunk and flushes the tail as a synthetic chunk before finish', () => {
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
    const r = new OpenAiSseRewriter(holder);
    expect(datas(r.push(contentChunk('secret bits')))).toEqual([]); // held ⇒ nothing emitted
    const evs = datas(r.push(finishChunk())).map((d) => JSON.parse(d) as OaChunk);
    expect(evs[0]?.choices?.[0]?.delta?.content).toBe('secret bits'); // synthetic tail chunk first
    expect(evs[1]?.choices?.[0]?.finish_reason).toBe('stop'); // then the real finish chunk
  });

  it('re-stringifies so a placeholder with quotes/newlines stays valid JSON', () => {
    const weird: TextTransform = { push: () => '<<GULLEY_"X"\n>>', flush: () => '' };
    const out = new OpenAiSseRewriter(weird).push(contentChunk('anything'));
    const o = JSON.parse(datas(out)[0] ?? '{}') as OaChunk;
    expect(o.choices?.[0]?.delta?.content).toBe('<<GULLEY_"X"\n>>');
  });

  it('fails closed on a multi-choice (n>1) stream instead of corrupting text', () => {
    const idChunk = (index: number, text: string): string =>
      oaChunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt',
        choices: [{ index, delta: { content: text }, finish_reason: null }],
      });
    const r = new OpenAiSseRewriter(identity);
    const out = r.push(idChunk(0, 'Hello') + idChunk(1, 'Bonjour'));
    expect(r.failClosed).toBe(true); // second choice index detected
    expect(out).not.toContain('Bonjour'); // the mis-indexed content is never emitted
    expect(r.push(idChunk(1, ' more'))).toBe(''); // terminal — nothing more
    expect(r.flush()).toBe('');
  });

  it('reassembles text split across two content chunks, flushing before usage/[DONE]', () => {
    let buf = '';
    const redact: TextTransform = {
      push: (t) => {
        buf += t;
        if (buf.length < 12) return '';
        const o = buf.replace(/SECRET/g, '[R]');
        buf = '';
        return o;
      },
      flush: () => {
        const o = buf.replace(/SECRET/g, '[R]');
        buf = '';
        return o;
      },
    };
    const r = new OpenAiSseRewriter(redact);
    let out = r.push(contentChunk('my SEC'));
    out += r.push(contentChunk('RET here'));
    out += r.push(finishChunk() + usageChunk() + DONE);
    out += r.flush();
    expect(contentOf(out)).toBe('my [R] here');
    expect(datas(out)).toContain('[DONE]');
  });
});
