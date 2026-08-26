import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { type BudgetStore, InMemoryBudgetStore } from '@gulley/budget';
import { AnthropicAdapter, AnthropicUsageExtractor } from '@gulley/providers';
import { InMemoryRateLimitStore, RateLimiter } from '@gulley/ratelimit';
import { CircuitBreaker, ModelRouter, type RouteTarget } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
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

function buildContext(
  store: InMemoryKeyStore,
  budgets: BudgetStore = new InMemoryBudgetStore(new Map()),
  rateLimiter?: RateLimiter,
): {
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
      rateLimiter,
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
      budgets,
      telemetry: initTelemetry({}),
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
      budgets: new InMemoryBudgetStore(new Map()),
      telemetry: initTelemetry({}),
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

  it('rejects a request whose worst-case reservation exceeds the workspace budget', async () => {
    const { store, token } = seededStore();
    // Tiny cap: sonnet-4-6 with max_tokens=1000 reserves well over 500 microUSD.
    const budgets = new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 500 }]]));
    const { ctx, requestLog } = buildContext(store, budgets);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(402);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('budget_exceeded');
    expect(requestLog.entries).toHaveLength(0); // never called upstream

    await app.close();
  });

  it('allows a request that fits within the workspace budget', async () => {
    const { store, token } = seededStore();
    const budgets = new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 10_000_000 }]]));
    const { ctx } = buildContext(store, budgets);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    await app.close();
  });

  it('enforces an RPM limit: 429 with x-ratelimit headers, no upstream call', async () => {
    const { store, token } = seededStore();
    const limiter = new RateLimiter({
      store: new InMemoryRateLimitStore(),
      resolve: () => [{ id: 'rpm', limit: 1, windowSeconds: 60, unit: 'requests' }],
    });
    const { ctx, requestLog } = buildContext(store, undefined, limiter);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const headers = { 'content-type': 'application/json', 'x-api-key': token };

    const first = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body });
    await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('1');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('0');

    const second = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body });
    const json = (await second.json()) as { error: { type: string } };
    expect(second.status).toBe(429);
    expect(json.error.type).toBe('rate_limit_error');
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(second.headers.get('x-ratelimit-remaining')).toBe('0');

    // Only the first (admitted) request reached upstream and was logged.
    expect(requestLog.entries).toHaveLength(1);

    await app.close();
  });

  it('injects a terminal error frame when the upstream stream breaks mid-flight', async () => {
    const broken = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      );
      setTimeout(() => res.destroy(), 20); // sever the connection mid-stream
    });
    await new Promise<void>((r) => broken.listen(0, '127.0.0.1', r));
    const brokenUrl = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('broken', brokenUrl) },
      },
    ];
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
    expect(text).toContain('message_start'); // partial content still delivered
    expect(text).toContain('event: error'); // clean terminal frame appended
    expect(text).toContain('"type":"api_error"');

    await app.close();
    await new Promise<void>((r) => broken.close(() => r()));
  });

  it('decompresses a gzip-encoded upstream before metering and forwarding', async () => {
    const gz = zlib.gzipSync(Buffer.from(GOLDEN_SSE, 'utf8'));
    const gzServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      res.end(gz);
    });
    await new Promise<void>((r) => gzServer.listen(0, '127.0.0.1', r));
    const gzUrl = `http://127.0.0.1:${(gzServer.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('gz', gzUrl) },
      },
    ];
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
    // Client receives decoded SSE, with the content-encoding header stripped.
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(text).toContain('message_start');
    expect(text).toContain('"stop_reason":"end_turn"');
    // Usage was metered from the DECODED stream, not gzip bytes.
    expect(ledger.entries[0]?.cost.outputTokens).toBe(42);

    await app.close();
    await new Promise<void>((r) => gzServer.close(() => r()));
  });

  it('aliases a requested model to a pinned upstream model', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.modelRouter = new ModelRouter([{ pattern: 'smart', target: 'claude-sonnet-4-6' }]);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'smart',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();
    expect(res.status).toBe(200);
    // Upstream received the pinned model, not the client's alias.
    expect(received.body).toContain('"model":"claude-sonnet-4-6"');
    expect(received.body).not.toContain('smart');

    await app.close();
  });

  it('applies request shaping defaults before forwarding', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes[0]!.shaping = { defaults: { max_tokens: 256 }, overrides: { top_p: 0.1 } };
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        top_p: 0.9,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(received.body).toContain('"max_tokens":256'); // default (absent) applied
    expect(received.body).toContain('"top_p":0.1'); // override wins over client 0.9

    await app.close();
  });

  it('serves GET /v1/models filtered to the caller and 401 without a key', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.models = ['claude-sonnet-4-6', 'gpt-4o'];
    ctx.modelRouter = new ModelRouter([{ pattern: 'smart', target: 'claude-sonnet-4-6' }]);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': token } });
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(res.status).toBe(200);
    expect(json.object).toBe('list');
    const ids = json.data.map((d) => d.id);
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('smart'); // known router alias

    const bad = await fetch(`${base}/v1/models`);
    expect(bad.status).toBe(401);

    await app.close();
  });
});

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
