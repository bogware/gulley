import { Readable } from 'node:stream';
import type { RouteTarget } from '@gulley/routing';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClassifierTargetEntry,
  GatewayClassifierCompleter,
} from './smart-classifier-completer';

function jsonStream(obj: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(obj), 'utf8')]);
}

function entry(
  forward: (req: unknown) => Promise<{ statusCode: number; headers: unknown; body: Readable }>,
): ClassifierTargetEntry {
  const target = {
    name: 'classifier',
    provider: 'anthropic',
    adapter: { forward } as never,
    credential: { scheme: 'bearer', value: 'x' },
    upstreamPath: '/v1/messages',
  } as unknown as RouteTarget;
  return { target, provider: 'anthropic' };
}

describe('GatewayClassifierCompleter', () => {
  it('forwards a small classification request and parses text + raw usage', async () => {
    const forward = vi.fn(async (_req: unknown) => ({
      statusCode: 200,
      headers: {},
      body: jsonStream({
        content: [{ type: 'text', text: 'cheap' }],
        usage: { input_tokens: 12, output_tokens: 1 },
      }),
    }));
    const c = new GatewayClassifierCompleter(new Map([['router-x', entry(forward)]]));

    const out = await c.complete('router-x', 'classify this');
    expect(out.text).toBe('cheap');
    expect(out.usage).toEqual({
      provider: 'anthropic',
      model: 'router-x',
      inputTokens: 12,
      outputTokens: 1,
    });
    // A tiny, non-streamed classification request.
    const req = forward.mock.calls[0]?.[0] as { body: Buffer } | undefined;
    expect(JSON.parse(req!.body.toString())).toMatchObject({ model: 'router-x', max_tokens: 16 });
  });

  it('abstains (empty text, no usage) on an upstream error status', async () => {
    const c = new GatewayClassifierCompleter(
      new Map([
        ['router-x', entry(async () => ({ statusCode: 429, headers: {}, body: jsonStream({}) }))],
      ]),
    );
    const out = await c.complete('router-x', 'x');
    expect(out).toEqual({ text: '' });
  });

  it('abstains for an unwired model (no forward at all)', async () => {
    const forward = vi.fn();
    const c = new GatewayClassifierCompleter(new Map([['router-x', entry(forward as never)]]));
    const out = await c.complete('unknown-model', 'x');
    expect(out).toEqual({ text: '' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('abstains on an unparseable response body', async () => {
    const c = new GatewayClassifierCompleter(
      new Map([
        [
          'router-x',
          entry(async () => ({
            statusCode: 200,
            headers: {},
            body: Readable.from([Buffer.from('not json', 'utf8')]),
          })),
        ],
      ]),
    );
    const out = await c.complete('router-x', 'x');
    expect(out).toEqual({ text: '' });
  });

  it('destroys the response stream and abstains on an over-cap body (no leak)', async () => {
    const big = Buffer.alloc(70 * 1024, 0x20); // 70KB > RESPONSE_CAP (64KB), invalid JSON
    const stream = Readable.from([big]);
    const c = new GatewayClassifierCompleter(
      new Map([['router-x', entry(async () => ({ statusCode: 200, headers: {}, body: stream }))]]),
    );
    const out = await c.complete('router-x', 'x');
    expect(out).toEqual({ text: '' });
    expect(stream.destroyed).toBe(true); // the socket/stream is not left undrained
  });

  it('returns text WITHOUT usage when the provider reports zero tokens (so no meter fires)', async () => {
    const c = new GatewayClassifierCompleter(
      new Map([
        [
          'router-x',
          entry(async () => ({
            statusCode: 200,
            headers: {},
            body: jsonStream({
              content: [{ type: 'text', text: 'cheap' }],
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          })),
        ],
      ]),
    );
    expect(await c.complete('router-x', 'x')).toEqual({ text: 'cheap' });
  });
});
