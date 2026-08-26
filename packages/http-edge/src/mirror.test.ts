import { describe, expect, it, vi } from 'vitest';
import { RequestMirror } from './mirror';

describe('RequestMirror', () => {
  it('samples deterministically by rate', () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body);
      return new Response('ok');
    }) as unknown as typeof fetch;

    // rand 0.9 with rate 0.5 → skip; rate 1 → always fire.
    const skip = new RequestMirror({ url: 'u', sampleRate: 0.5, rand: () => 0.9, fetchImpl });
    expect(skip.fire('{}')).toBe(false);
    const always = new RequestMirror({ url: 'u', sampleRate: 1, rand: () => 0.9, fetchImpl });
    expect(always.fire('{"a":1}')).toBe(true);
    // rate 0 never fires.
    expect(new RequestMirror({ url: 'u', sampleRate: 0, fetchImpl }).fire('{}')).toBe(false);
  });

  it('is fire-and-forget: never throws even when the shadow endpoint errors', async () => {
    const boom = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const mirror = new RequestMirror({ url: 'u', sampleRate: 1, fetchImpl: boom });
    expect(() => mirror.fire('{}')).not.toThrow(); // synchronous fire never throws
    await Promise.resolve(); // let the detached send reject internally — must be swallowed
  });

  it('sends the effective body with the configured shadow headers', async () => {
    const seen: { body?: unknown; headers?: Record<string, string> } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.body = init.body;
      seen.headers = init.headers as Record<string, string>;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const mirror = new RequestMirror({
      url: 'https://shadow/v1',
      sampleRate: 1,
      headers: { authorization: 'Bearer shadow' },
      rand: () => 0,
      fetchImpl,
    });
    mirror.fire('{"prompt":"masked"}');
    await vi.waitFor(() => expect(seen.body).toBe('{"prompt":"masked"}'));
    expect(seen.headers?.['authorization']).toBe('Bearer shadow');
    expect(seen.headers?.['content-type']).toBe('application/json');
  });
});
