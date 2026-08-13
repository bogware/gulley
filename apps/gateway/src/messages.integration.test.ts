import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor } from '@gulley/providers';
import { CircuitBreaker, type RouteTarget } from '@gulley/routing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'itest-pepper';
const UPSTREAM_KEY = 'sk-ant-upstream-secret';

const GOLDEN_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

let upstream: http.Server;
let upstreamUrl: string;
let received: { apiKey?: string; auth?: string; body: string } = { body: '' };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    received = { apiKey: undefined, auth: undefined, body: '' };
    received.apiKey = single(req.headers['x-api-key']);
    received.auth = single(req.headers['authorization']);
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      received.body = body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(GOLDEN_SSE);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function testConfig() {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);
}

function buildContext(store: InMemoryKeyStore): {
  ctx: GatewayContext;
  ledger: InMemoryLedger;
  requestLog: InMemoryRequestLog;
  audit: InMemoryAuditSink;
  breaker: CircuitBreaker;
} {
  const ledger = new InMemoryLedger();
  const requestLog = new InMemoryRequestLog();
  const audit = new InMemoryAuditSink();
  const breaker = new CircuitBreaker();
  return {
    ctx: {
      routes: [
        {
          clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'single',
            target: {
              name: 'anthropic',
              provider: 'anthropic',
              adapter: new AnthropicAdapter({ baseUrl: upstreamUrl }),
              credential: { scheme: 'x-api-key', value: UPSTREAM_KEY },
              upstreamPath: '/v1/messages',
            },
          },
        },
      ],
      keyStore: store,
      pepper: PEPPER,
      ledger,
      requestLog,
      audit,
      breaker,
    },
    ledger,
    requestLog,
    audit,
    breaker,
  };
}

function anthropicTarget(name: string, baseUrl: string): RouteTarget {
  return {
    name,
    provider: 'anthropic',
    adapter: new AnthropicAdapter({ baseUrl }),
    credential: { scheme: 'x-api-key', value: UPSTREAM_KEY },
    upstreamPath: '/v1/messages',
  };
}

function seededStore(): { store: InMemoryKeyStore; token: string } {
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_1',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'CI key',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });
  return { store, token: gen.token };
}

describe('POST /v1/messages (Anthropic passthrough)', () => {
  it('streams a request through, swaps the credential, and meters + audits it', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger, requestLog, audit } = buildContext(store);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('message_start');
    expect(text).toContain('"stop_reason":"end_turn"');

    // The client's virtual key never reaches Anthropic; the gateway's key does.
    expect(received.apiKey).toBe(UPSTREAM_KEY);
    expect(received.auth).toBeUndefined();

    // Metered from the raw usage: output from message_delta (42, not the 1 in start).
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.model).toBe('claude-sonnet-4-6');
    expect(ledger.entries[0]?.workspaceId).toBe('ws_1');
    expect(ledger.entries[0]?.cost.outputTokens).toBe(42);
    expect(ledger.entries[0]?.cost.totalInputTokens).toBe(130);
    expect(ledger.entries[0]?.status).toBe('ok');

    expect(requestLog.entries).toHaveLength(1);
    expect(requestLog.entries[0]?.streamed).toBe(true);
    expect(requestLog.entries[0]?.statusCode).toBe(200);

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.action).toBe('proxy.request');
    expect(audit.verify()).toBe(true);

    await app.close();
  });

  it('rejects an invalid virtual key with a generic 401 and does not call upstream', async () => {
    const { store } = seededStore();
    const { ctx, requestLog } = buildContext(store);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'gk_deadbeef0000_nope' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true }),
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('authentication_error');
    expect(requestLog.entries).toHaveLength(0);

    await app.close();
  });

  it('fails over pre-first-byte from an unreachable target to a healthy one', async () => {
    const { store, token } = seededStore();
    const ledger = new InMemoryLedger();
    const requestLog = new InMemoryRequestLog();
    const audit = new InMemoryAuditSink();
    const breaker = new CircuitBreaker();
    const ctx: GatewayContext = {
      routes: [
        {
          clientPaths: ['/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'fallback',
            targets: [
              anthropicTarget('bad', 'http://127.0.0.1:1'), // connection refused
              anthropicTarget('good', upstreamUrl),
            ],
          },
        },
      ],
      keyStore: store,
      pepper: PEPPER,
      ledger,
      requestLog,
      audit,
      breaker,
    };
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-target')).toBe('good'); // served by the fallback
    expect(text).toContain('message_start');
    expect(ledger.entries[0]?.status).toBe('ok');
    expect(ledger.entries[0]?.cost.outputTokens).toBe(42);

    await app.close();
  });
});

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
