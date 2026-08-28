import { describe, expect, it } from 'vitest';
import { SSEParser } from './sse';
import {
  AnthropicSseRewriter,
  OpenAiSseRewriter,
  ResponsesSseRewriter,
  type TextTransform,
} from './sse-rewriter';

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

  it('fails closed on a second text content-block index instead of mis-attributing', () => {
    const r = new AnthropicSseRewriter(identity);
    const out = r.push(textDelta(0, 'first block ') + textDelta(1, 'SECOND block'));
    expect(r.failClosed).toBe(true); // a second text-block index was detected
    expect(out).not.toContain('SECOND block'); // the second block's text is not emitted
    expect(r.push(textDelta(1, ' more'))).toBe(''); // terminal — nothing more
    expect(r.flush()).toBe('');
  });

  it('does NOT fail closed on a tool_use block interleaved with a single text block', () => {
    const r = new AnthropicSseRewriter(identity);
    let out = r.push(textDelta(0, 'hello '));
    // A tool_use block on index 1 carries input_json_delta, not text_delta — fine.
    out += r.push(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      }),
    );
    out += r.push(textDelta(0, 'world'));
    out += r.flush();
    expect(r.failClosed).toBe(false); // single text block + a tool_use block is allowed
    const text = parse(out)
      .filter((e) => e.obj.type === 'content_block_delta' && e.obj.delta?.type === 'text_delta')
      .map((e) => e.obj.delta?.text ?? '')
      .join('');
    expect(text).toBe('hello world');
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

  it('strips per-token logprobs (they echo the raw text token-by-token)', () => {
    const chunkWithLogprobs = oaChunk({
      id: 'c1',
      object: 'chat.completion.chunk',
      model: 'gpt',
      choices: [
        {
          index: 0,
          delta: { content: 'sk-live' },
          finish_reason: null,
          logprobs: { content: [{ token: 'sk' }, { token: '-live' }] },
        },
      ],
    });
    const out = new OpenAiSseRewriter(identity).push(chunkWithLogprobs);
    expect(out).toContain('sk-live'); // the (identity-transformed) content survives
    expect(out).not.toContain('logprobs'); // but the per-token logprobs are gone
    expect(out).not.toContain('"token"');
  });
});

describe('ResponsesSseRewriter', () => {
  const rframe = (event: string, obj: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
  const otDelta = (delta: string, oi = 0, ci = 0): string =>
    rframe('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: oi,
      content_index: ci,
      delta,
      sequence_number: 1,
    });
  const otDone = (text: string): string =>
    rframe('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text,
    });
  const cpDone = (text: string): string =>
    rframe('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
  const completed = (text: string, usage: unknown): string =>
    rframe('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage,
      },
    });

  type Any = Record<string, unknown>;
  const events = (sse: string): Array<{ event?: string; obj: Any }> =>
    new SSEParser().push(sse).map((e) => ({ event: e.event, obj: JSON.parse(e.data) as Any }));
  const upper: TextTransform = { push: (t) => t.toUpperCase(), flush: () => '' };

  it('passes non-output_text events through verbatim', () => {
    const r = new ResponsesSseRewriter(upper);
    const input =
      rframe('response.created', { type: 'response.created', response: { id: 'r' } }) +
      rframe('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        delta: 'thinking...',
      }) +
      rframe('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        delta: '{"a":1}',
      });
    const out = events(r.push(input) + r.flush());
    expect(out.map((e) => e.obj['type'])).toEqual([
      'response.created',
      'response.reasoning_summary_text.delta',
      'response.function_call_arguments.delta',
    ]);
    // reasoning + tool args untouched (not output_text)
    expect(out[1]?.obj['delta']).toBe('thinking...');
    expect(out[2]?.obj['delta']).toBe('{"a":1}');
  });

  it('transforms deltas AND keeps every echo consistent with the accumulator', () => {
    const r = new ResponsesSseRewriter(upper);
    const usage = { input_tokens: 5, output_tokens: 3 };
    let out = r.push(otDelta('hello ') + otDelta('world'));
    out += r.push(otDone('hello world') + cpDone('hello world') + completed('hello world', usage));
    out += r.flush();
    const evs = events(out);

    // deltas transformed
    const deltas = evs.filter((e) => e.obj['type'] === 'response.output_text.delta');
    expect(deltas.map((e) => e.obj['delta'])).toEqual(['HELLO ', 'WORLD']);
    // output_text.done.text == accumulator (NOT the raw echo)
    expect(evs.find((e) => e.obj['type'] === 'response.output_text.done')?.obj['text']).toBe(
      'HELLO WORLD',
    );
    // content_part.done.part.text == accumulator
    const cp = evs.find((e) => e.obj['type'] === 'response.content_part.done');
    expect((cp?.obj['part'] as Any)['text']).toBe('HELLO WORLD');
    // response.completed output text == accumulator, usage byte-untouched
    const done = evs.find((e) => e.obj['type'] === 'response.completed');
    const resp = done?.obj['response'] as Any;
    const block = ((resp['output'] as Any[])[0]!['content'] as Any[])[0]!;
    expect(block['text']).toBe('HELLO WORLD');
    expect(resp['usage']).toEqual(usage); // metering value preserved exactly
  });

  it('flushes a windowed held tail before output_text.done (synthetic event-named delta)', () => {
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
    const r = new ResponsesSseRewriter(holder);
    let out = r.push(otDelta('secret'));
    expect(events(out)).toHaveLength(0); // held back
    out = r.push(otDone('secret'));
    const evs = events(out);
    // a synthetic event-named delta carries the flushed tail, THEN the done echo
    expect(evs[0]?.event).toBe('response.output_text.delta');
    expect(evs[0]?.obj['delta']).toBe('secret');
    expect(evs[1]?.obj['type']).toBe('response.output_text.done');
    expect(evs[1]?.obj['text']).toBe('secret'); // echo == accumulator
  });

  it('sets failClosed on a second output_text part', () => {
    const r = new ResponsesSseRewriter(upper);
    r.push(otDelta('a', 0, 0));
    const out = r.push(otDelta('b', 0, 1)); // different content_index → second part
    expect(r.failClosed).toBe(true);
    expect(out).toBe('');
  });

  const outputItemDone = (text: string): string =>
    rframe('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    });

  it('scrubs response.output_item.done — the item echo that leaks the full text', () => {
    const r = new ResponsesSseRewriter(upper);
    let out = r.push(otDelta('a secret'));
    out += r.push(otDone('a secret') + outputItemDone('a secret') + completed('a secret', {}));
    const evs = events(out);
    // The output_item.done frame's item text is the accumulator, NOT the raw echo.
    const item = evs.find((e) => e.obj['type'] === 'response.output_item.done');
    const block = ((item?.obj['item'] as Any)['content'] as Any[])[0]!;
    expect(block['text']).toBe('A SECRET');
    expect(out).not.toContain('a secret'); // raw text leaks in no frame
  });

  it('strips per-token logprobs from every rewritten frame (they echo the raw text)', () => {
    const r = new ResponsesSseRewriter(upper);
    const deltaWithLogprobs = rframe('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'sk-live',
      logprobs: [
        { token: 'sk', logprob: -0.1 },
        { token: '-live', logprob: -0.2 },
      ],
    });
    const doneWithLogprobs = rframe('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text: 'sk-live',
      logprobs: [{ token: 'sk', logprob: -0.1 }],
    });
    const out = r.push(deltaWithLogprobs + doneWithLogprobs);
    expect(out).not.toContain('logprobs');
    expect(out).not.toContain('"token"');
    expect(out).not.toContain('sk-live'); // raw token text gone
  });

  it('fails closed if an output_text echo carries text never seen as a delta', () => {
    // Non-conformant: text appears only in output_text.done, never windowed via a
    // delta — substituting would blank it, passing through would bypass enforcement.
    const r = new ResponsesSseRewriter(upper);
    const out = r.push(otDone('never streamed'));
    expect(r.failClosed).toBe(true);
    expect(out).toBe('');
  });

  it('flush() emits the held tail as a synthetic delta for a truncated stream', () => {
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
    const r = new ResponsesSseRewriter(holder);
    r.push(otDelta('tail'));
    const evs = events(r.flush());
    expect(evs[0]?.event).toBe('response.output_text.delta');
    expect(evs[0]?.obj['delta']).toBe('tail');
  });
});
