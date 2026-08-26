import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { generateVirtualKey, InMemoryKeyStore, parseHtpasswd } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { type BudgetStore, InMemoryBudgetStore } from '@gulley/budget';
import { CelAuthorizer, CelTransformer, ExternalAuthorizer } from '@gulley/cel';
import { GuardrailEngine, NativeDetector } from '@gulley/guardrails';
import { RequestMirror } from '@gulley/http-edge';
import { OidcProvider } from '@gulley/oidc';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { AnthropicAdapter, AnthropicUsageExtractor, OpenAIUsageExtractor } from '@gulley/providers';
import { InMemoryRateLimitStore, RateLimiter } from '@gulley/ratelimit';
import { CircuitBreaker, ModelRouter, type RouteTarget } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { buildCustomProviders } from './context';
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
let received: {
  apiKey?: string;
  auth?: string;
  traceparent?: string;
  tenant?: string;
  body: string;
} = { body: '' };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    received = { apiKey: undefined, auth: undefined, body: '' };
    received.apiKey = single(req.headers['x-api-key']);
    received.auth = single(req.headers['authorization']);
    received.traceparent = single(req.headers['traceparent']);
    received.tenant = single(req.headers['x-tenant']);
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

  it('routes to a keyless local OpenAI-compatible provider (Ollama-style)', async () => {
    let localAuth: string | undefined = 'unset';
    let localBody = '';
    const local = http.createServer((req, res) => {
      localAuth = req.headers['authorization'];
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        localBody = b;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl',
            model: 'llama3.1',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;

    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CUSTOM_PROVIDERS: JSON.stringify([
        { provider: 'ollama', baseUrl: localUrl, models: ['llama3.1'] },
      ]),
    } as NodeJS.ProcessEnv);
    const custom = buildCustomProviders(config);

    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.routes = [
      ...custom.routes,
      {
        clientPaths: ['/v1/chat/completions'],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: custom.routes[0]!.strategy,
      },
    ];
    ctx.modelRouter = new ModelRouter(custom.modelRules);
    ctx.models = custom.models;

    const app = buildServer(config, ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const headers = { 'content-type': 'application/json', 'x-api-key': token };
    const bodyFor = (model: string) =>
      JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });

    // Namespaced path → the local runtime, keyless, metered under 'ollama'.
    const r1 = await fetch(`${base}/ollama/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: bodyFor('llama3.1'),
    });
    await r1.text();
    expect(r1.status).toBe(200);
    expect(localAuth).toBeUndefined(); // keyless — no Authorization sent upstream
    expect(localBody).toContain('llama3.1');
    expect(ledger.entries.at(-1)?.provider).toBe('ollama');
    expect(ledger.entries.at(-1)?.cost.outputTokens).toBe(5);

    // Shared endpoint dispatched by model to the same local backend.
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: bodyFor('llama3.1'),
    });
    await r2.text();
    expect(r2.status).toBe(200);
    expect(ledger.entries.at(-1)?.provider).toBe('ollama');

    await app.close();
    await new Promise<void>((r) => local.close(() => r()));
  });

  it('proxies and meters an embeddings request to a local provider', async () => {
    const emb = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: 'nomic-embed-text',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 8, total_tokens: 8 },
        }),
      );
    });
    await new Promise<void>((r) => emb.listen(0, '127.0.0.1', r));
    const embUrl = `http://127.0.0.1:${(emb.address() as AddressInfo).port}`;

    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CUSTOM_PROVIDERS: JSON.stringify([{ provider: 'ollama', baseUrl: embUrl, embeddings: true }]),
    } as NodeJS.ProcessEnv);
    const custom = buildCustomProviders(config);

    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.routes = custom.routes;

    const app = buildServer(config, ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/ollama/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'nomic-embed-text', input: 'hello' }),
    });
    await res.text();
    expect(res.status).toBe(200);
    expect(ledger.entries.at(-1)?.provider).toBe('ollama');
    expect(ledger.entries.at(-1)?.cost.totalInputTokens).toBe(8);

    await app.close();
    await new Promise<void>((r) => emb.close(() => r()));
  });

  it('retries the same target on a transient 503 (pre-first-byte body replay)', async () => {
    let calls = 0;
    const flaky = http.createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503);
        res.end('overloaded');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(GOLDEN_SSE);
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r));
    const flakyUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.retryMaxAttempts = 2;
    ctx.retryBackoffMs = 1;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('flaky', flakyUrl) },
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
    expect(calls).toBe(2); // first 503, retried once → success on the same target
    expect(text).toContain('message_start');

    await app.close();
    await new Promise<void>((r) => flaky.close(() => r()));
  });

  it('enforces a CEL authorization deny rule', async () => {
    const { store, token } = seededStore();
    const { ctx, requestLog } = buildContext(store);
    ctx.authorizer = new CelAuthorizer(
      [{ effect: 'deny', name: 'no-opus', expr: 'request.model.contains("opus")' }],
      { declaredVars: ['request', 'principal'] },
    );
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const headers = { 'content-type': 'application/json', 'x-api-key': token };

    const denied = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [] }),
    });
    expect(denied.status).toBe(403);
    const json = (await denied.json()) as { error: { type: string } };
    expect(json.error.type).toBe('permission_error');
    expect(requestLog.entries).toHaveLength(0); // never reached upstream

    const ok = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await ok.text();
    expect(ok.status).toBe(200);

    await app.close();
  });

  it('authenticates a data-plane request with an inbound JWT, scoped from claims', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
      ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      kid: 'k1',
      alg: 'RS256',
    };
    const b64 = (o: unknown): string =>
      Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const sign = (claims: Record<string, unknown>): string => {
      const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
      const p = b64(claims);
      const s = createSign('RSA-SHA256')
        .update(`${h}.${p}`)
        .end()
        .sign(privateKey)
        .toString('base64url');
      return `${h}.${p}.${s}`;
    };
    const idpFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://idp.test',
            authorization_endpoint: 'https://idp.test/a',
            token_endpoint: 'https://idp.test/t',
            jwks_uri: 'https://idp.test/jwks',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }) as unknown as typeof fetch;

    const jwt = sign({
      iss: 'https://idp.test',
      aud: 'gulley',
      sub: 'svc-1',
      gulley_workspace: 'ws_1',
      gulley_org: 'org_1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const { store } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.jwtAuth = {
      provider: new OidcProvider('https://idp.test', { fetchImpl: idpFetch }),
      audience: 'gulley',
      workspaceClaim: 'gulley_workspace',
      orgClaim: 'gulley_org',
    };
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const ok = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body,
    });
    await ok.text();
    expect(ok.status).toBe(200);
    expect(ledger.entries.at(-1)?.workspaceId).toBe('ws_1'); // scope from the JWT claim
    expect(ledger.entries.at(-1)?.principalId).toBe('svc-1');

    const bad = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.bad',
      },
      body,
    });
    expect(bad.status).toBe(401);

    await app.close();
  });

  it('hold-then-flush withholds a streamed response that violates the output policy', async () => {
    const leaky = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: content_block_delta\ndata: {"delta":{"text":"here is a key AKIAIOSFODNN7EXAMPLE"}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n',
      );
    });
    await new Promise<void>((r) => leaky.listen(0, '127.0.0.1', r));
    const leakyUrl = `http://127.0.0.1:${(leaky.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    const engine = new GuardrailEngine([new NativeDetector({})], {
      input: { action: 'audit' },
      output: { action: 'block' },
    });
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('leaky', leakyUrl) },
        guardrails: engine,
        holdStreamedOutput: true,
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
    expect(res.headers.get('x-gulley-guardrail')).toBe('output-blocked');
    expect(text).not.toContain('AKIA'); // secret withheld, not streamed to the client
    expect(text).toContain('event: error');

    await app.close();
    await new Promise<void>((r) => leaky.close(() => r()));
  });

  it('withholds a buffered response that overflows the enforcement buffer (fail-closed)', async () => {
    const big = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // A non-streamed body far larger than the tiny buffer limit below, carrying
      // a secret the output guardrail would have caught had it fit.
      res.end(JSON.stringify({ content: 'AKIAIOSFODNN7EXAMPLE ' + 'x'.repeat(2000) }));
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const bigUrl = `http://127.0.0.1:${(big.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.responseBufferLimit = 50; // force overflow
    ctx.bufferFailClosed = true;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('big', bigUrl) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action: 'block' },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    expect(res.headers.get('x-gulley-guardrail')).toBe('output-blocked-overflow');
    expect(text).not.toContain('AKIA'); // the over-cap body never reaches the client
    expect(text).toContain('too large to enforce');

    await app.close();
    await new Promise<void>((r) => big.close(() => r()));
  });

  it('applies CEL request/response transformation', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.transformer = new CelTransformer(
      {
        requestBody: [{ field: 'max_tokens', value: '128' }],
        responseHeaders: [{ name: 'X-Policy', value: '"applied-" + principal.workspaceId' }],
      },
      { declaredVars: ['request', 'principal'] },
    );
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
    await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-policy')).toBe('applied-ws_1'); // response header injected
    expect(received.body).toContain('"max_tokens":128'); // request body field injected upstream

    await app.close();
  });

  it('mirrors a sampled copy of the request to a shadow endpoint without affecting it', async () => {
    let shadowBody = '';
    const shadow = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        shadowBody = b;
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => shadow.listen(0, '127.0.0.1', r));
    const shadowUrl = `http://127.0.0.1:${(shadow.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.mirror = new RequestMirror({ url: shadowUrl, sampleRate: 1 });
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'shadow me' }],
      }),
    });
    await res.text();
    expect(res.status).toBe(200); // the real request is unaffected

    // The shadow received the request body; it was NOT metered a second time.
    await vi.waitFor(() => expect(shadowBody).toContain('shadow me'));
    expect(ledger.entries).toHaveLength(1); // exactly one real metering, not two

    await app.close();
    await new Promise<void>((r) => shadow.close(() => r()));
  });

  it('applies the static header modifier (request injected upstream, response to client)', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.headerModifier = {
      request: { set: { 'x-tenant': 'acme' } },
      response: { set: { 'x-gateway': 'gulley' } },
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
    await res.text();
    expect(res.status).toBe(200);
    expect(received.tenant).toBe('acme'); // request header reached upstream
    expect(res.headers.get('x-gateway')).toBe('gulley'); // response header reached the client

    await app.close();
  });

  it('continues a client W3C trace and injects traceparent upstream', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.tracePropagation = { sampleRatio: 1 };
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token, traceparent: inbound },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();
    expect(res.status).toBe(200);
    // Same trace-id, a fresh span-id (the gateway's own span), sampled honored.
    expect(received.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(received.traceparent).not.toContain('00f067aa0ba902b7');

    await app.close();
  });

  it('denies a request rejected by the external authorization hook (403)', async () => {
    const { store, token } = seededStore();
    const { ctx, requestLog } = buildContext(store);
    const denyFetch = (async () =>
      new Response(JSON.stringify({ allow: false, reason: 'blocked-by-policy-svc' }), {
        status: 200,
      })) as unknown as typeof fetch;
    ctx.externalAuthorizer = new ExternalAuthorizer({
      url: 'https://policy/authz',
      fetchImpl: denyFetch,
    });
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

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('permission_error');
    expect(requestLog.entries).toHaveLength(0); // never forwarded upstream

    await app.close();
  });

  it('authenticates an inbound HTTP Basic user (htpasswd) and scopes the request', async () => {
    const { store } = seededStore();
    const { ctx, ledger } = buildContext(store);
    // apr1 hash of "s3cr3t-pass" (openssl passwd -apr1).
    ctx.basicAuth = {
      htpasswd: parseHtpasswd('alice:$apr1$Xy9zAbW1$yWHFWKOrw3L2VFJNzY4D81'),
      users: new Map([
        ['alice', { allowedModels: ['claude-sonnet-4-6'], allowedProviders: ['anthropic'] }],
      ]),
      defaultOrgId: 'org_1',
      defaultWorkspaceId: 'ws_basic',
    };
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('primary', upstreamUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    const call = (auth: string) =>
      fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

    const ok = await call(basic('alice', 's3cr3t-pass'));
    await ok.text();
    expect(ok.status).toBe(200);
    expect(ledger.entries[0]?.status).toBe('ok'); // metered under the Basic principal

    const bad = await call(basic('alice', 'wrong-pass'));
    const badJson = (await bad.json()) as { error: { type: string } };
    expect(bad.status).toBe(401);
    expect(badJson.error.type).toBe('authentication_error');

    await app.close();
  });

  it('session affinity pins a session to the same loadbalance target across requests', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    // Two targets to the SAME upstream (so both serve), distinguished only by
    // name; HRW must resolve one deterministically per session id.
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: {
          mode: 'loadbalance',
          targets: [anthropicTarget('ta', upstreamUrl), anthropicTarget('tb', upstreamUrl)],
        },
      },
    ];
    ctx.sessionAffinityHeader = 'x-session-id';
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const call = () =>
      fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          'x-session-id': 'affinity-user-9',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

    const first = await call();
    await first.text();
    const pinned = first.headers.get('x-gulley-target');
    expect(pinned).toMatch(/^t[ab]$/);

    for (let i = 0; i < 3; i++) {
      const r = await call();
      await r.text();
      expect(r.headers.get('x-gulley-target')).toBe(pinned); // sticky
    }

    await app.close();
  });
});

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
