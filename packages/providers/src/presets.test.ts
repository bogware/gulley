import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PassthroughAdapter } from './anthropic';
import { PROVIDER_PRESETS, resolveCustomProvider } from './presets';

describe('resolveCustomProvider', () => {
  it('resolves a local preset (keyless, loopback, http)', () => {
    const r = resolveCustomProvider({ preset: 'ollama', models: ['llama3.1', 'qwen2.5'] });
    expect(r.provider).toBe('ollama');
    expect(r.baseUrl).toBe('http://localhost:11434');
    expect(r.chatPath).toBe('/v1/chat/completions');
    expect(r.apiKey).toBe('');
    expect(r.local).toBe(true);
    expect(r.models).toEqual(['llama3.1', 'qwen2.5']);
  });

  it('lets an entry override the preset base URL and key', () => {
    const r = resolveCustomProvider({
      preset: 'ollama',
      baseUrl: 'http://gpu-box.lan:11434',
      apiKey: 'k',
    });
    expect(r.baseUrl).toBe('http://gpu-box.lan:11434');
    expect(r.apiKey).toBe('k');
  });

  it('resolves a bespoke provider with no preset', () => {
    const r = resolveCustomProvider({
      provider: 'myllm',
      baseUrl: 'https://llm.internal/v1',
      apiKey: 'secret',
    });
    expect(r.provider).toBe('myllm');
    expect(r.local).toBe(false);
  });

  it('rejects unknown presets and missing required fields', () => {
    expect(() => resolveCustomProvider({ preset: 'nope' })).toThrow(/unknown provider preset/);
    expect(() => resolveCustomProvider({ baseUrl: 'http://x' })).toThrow(/provider/);
    expect(() => resolveCustomProvider({ provider: 'x' })).toThrow(/baseUrl/);
  });

  it('ships hosted and local presets', () => {
    expect(PROVIDER_PRESETS['groq']?.requiresKey).toBe(true);
    expect(PROVIDER_PRESETS['ollama']?.local).toBe(true);
    expect(PROVIDER_PRESETS['lmstudio']?.baseUrl).toContain('1234');
  });

  it('resolves Gemini via its OpenAI-compatible surface', () => {
    const r = resolveCustomProvider({ preset: 'gemini', apiKey: 'k', embeddings: true });
    expect(r.baseUrl).toContain('generativelanguage.googleapis.com');
    expect(r.chatPath).toBe('/chat/completions');
    expect(r.embeddingsPath).toBe('/embeddings');
  });

  it('treats embeddings as opt-in with a default path', () => {
    expect(resolveCustomProvider({ preset: 'ollama' }).embeddingsPath).toBeUndefined();
    expect(resolveCustomProvider({ preset: 'ollama', embeddings: true }).embeddingsPath).toBe(
      '/v1/embeddings',
    );
  });
});

describe('PassthroughAdapter keyless mode', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('sends no auth header when the credential value is empty', async () => {
    let seenAuth: string | undefined = 'unset';
    server = http.createServer((req, res) => {
      seenAuth = req.headers['authorization'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const adapter = new PassthroughAdapter({ name: 'ollama', baseUrl: url });
    const res = await adapter.forward({
      path: '/v1/chat/completions',
      body: Buffer.from('{"model":"llama3.1"}'),
      headers: {},
      credential: { scheme: 'bearer', value: '' },
      signal: new AbortController().signal,
    });
    res.body.resume();
    expect(res.statusCode).toBe(200);
    expect(seenAuth).toBeUndefined();
  });
});
