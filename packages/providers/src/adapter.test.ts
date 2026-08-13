import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AzureAdapter, OpenAIAdapter } from './anthropic';

let server: http.Server | undefined;

interface Captured {
  headers: http.IncomingHttpHeaders;
  path: string;
}

function mock(): Promise<{ url: string; get: () => Captured }> {
  let captured: Captured = { headers: {}, path: '' };
  server = http.createServer((req, res) => {
    captured = { headers: req.headers, path: req.url ?? '' };
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, get: () => captured });
    });
  });
}

async function drain(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => {
    body.on('end', () => resolve());
    body.resume();
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('PassthroughAdapter credential schemes', () => {
  it('injects the Azure api-key header, strips the client credential, and remaps the path', async () => {
    const m = await mock();
    const adapter = new AzureAdapter({ baseUrl: m.url });
    const res = await adapter.forward({
      path: '/openai/v1/chat/completions',
      body: Buffer.from('{}'),
      headers: { authorization: 'Bearer gk_client', 'x-api-key': 'gk_client' },
      credential: { scheme: 'api-key', value: 'azure-secret' },
      signal: new AbortController().signal,
    });
    await drain(res.body);

    const h = m.get().headers;
    expect(h['api-key']).toBe('azure-secret');
    expect(h['authorization']).toBeUndefined(); // client bearer stripped
    expect(h['x-api-key']).toBeUndefined(); // client x-api-key stripped
    expect(m.get().path).toBe('/openai/v1/chat/completions');
  });

  it('injects a bearer credential for OpenAI', async () => {
    const m = await mock();
    const adapter = new OpenAIAdapter({ baseUrl: m.url });
    const res = await adapter.forward({
      path: '/v1/chat/completions',
      body: Buffer.from('{}'),
      headers: {},
      credential: { scheme: 'bearer', value: 'sk-openai' },
      signal: new AbortController().signal,
    });
    await drain(res.body);

    expect(m.get().headers['authorization']).toBe('Bearer sk-openai');
  });
});
