import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { generateVirtualKey, InMemoryKeyStore, parseHtpasswd } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { type BudgetStore, InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAesCipher } from '@gulley/crypto';
import type { MaskVaultRecord } from '@gulley/storage';
import { CelAuthorizer, CelTransformer, ExternalAuthorizer } from '@gulley/cel';
import { CacheEngine, InMemoryExactCache } from '@gulley/cache';
import { GuardrailEngine, NativeDetector } from '@gulley/guardrails';
import { RequestMirror } from '@gulley/http-edge';
import { RequestTracer } from './tracer';
import { MapTenantCredentialResolver } from './tenant';
import { MapTenantRouteResolver } from './tenant-routes';
import { OidcProvider } from '@gulley/oidc';
import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  OpenAIUsageExtractor,
  SSEParser,
} from '@gulley/providers';
import { InMemoryRateLimitStore, RateLimiter } from '@gulley/ratelimit';
import { AdaptiveLimiter, CircuitBreaker, ModelRouter, type RouteTarget } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { buildCustomProviders } from './context';
import type { GatewayContext, ProviderRoute } from './routes/messages';
import { buildServer } from './server';
import { buildSmartRouter } from './smart-router';
import type { ClassifierCompleter, SmartRoutingPolicy } from '@gulley/routing';

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
      playgroundEnabled: true,
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

  it('round-trips provider-affine artifacts: cache_control up, thinking signature down', async () => {
    // Provider-affine artifacts (Anthropic prompt-cache `cache_control` on the way
    // in, extended-thinking `signature` on the way out) must survive the gateway
    // byte-for-byte — the raw-pipe fidelity invariant. Synthesizing or dropping
    // them silently breaks prompt-cache hits and thinking-signature continuation.
    const SIG = 'EqoBCkgIARABGAIiQ' + 'fakethinkingsig9876543210';
    const THINK_SSE = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_t","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${SIG}"}}`,
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    let seenBody = '';
    const thinker = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        seenBody = b;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(THINK_SSE);
      });
    });
    await new Promise<void>((r) => thinker.listen(0, '127.0.0.1', r));
    const thinkerUrl = `http://127.0.0.1:${(thinker.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', thinkerUrl) },
      },
    ];
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
        system: [{ type: 'text', text: 'ctx', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    // Request round-trip: the prompt-cache marker reached the upstream verbatim.
    expect(seenBody).toContain('"cache_control":{"type":"ephemeral"}');
    // Response round-trip: the thinking signature reached the client verbatim.
    expect(text).toContain(`"signature":"${SIG}"`);
    expect(text).toContain('signature_delta');

    await app.close();
    await new Promise<void>((r) => thinker.close(() => r()));
  });

  it('sheds with 503 + Retry-After when every candidate is at capacity', async () => {
    const { store, token } = seededStore();
    const { ctx, requestLog, ledger } = buildContext(store);
    const limiter = new AdaptiveLimiter({ minLimit: 1, initialLimit: 1 });
    ctx.limiter = limiter;
    expect(limiter.tryAcquire('anthropic')).toBe(true); // occupy the only slot
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('overloaded_error');
    // Load-shed, not a served request: nothing metered, but teardown still logged it.
    expect(ledger.entries).toHaveLength(0);
    expect(requestLog.entries.some((e) => e.statusCode === 503)).toBe(true);

    await app.close();
  });

  it('releases the adaptive-concurrency slot in teardown so a later request is admitted', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.limiter = new AdaptiveLimiter({ minLimit: 1, initialLimit: 1 }); // one slot
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    // Two SEQUENTIAL requests over a single-slot limiter: the second can only be
    // admitted if the first released its slot in teardown.
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': token },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      await res.text();
      expect(res.status).toBe(200);
    }

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

  it('hedges a slow primary: serves the fast secondary, aborts the primary, meters once', async () => {
    let slowHit = false;
    let slowAborted = false;
    let slowResponded = false;
    const slow = http.createServer((req, res) => {
      slowHit = true;
      req.resume();
      const t = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        slowResponded = true;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(GOLDEN_SSE);
      }, 400);
      res.on('close', () => {
        clearTimeout(t);
        if (!slowResponded) slowAborted = true;
      });
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const fast = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(GOLDEN_SSE);
    });
    await new Promise<void>((r) => fast.listen(0, '127.0.0.1', r));
    const fastUrl = `http://127.0.0.1:${(fast.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        hedgeDelayMs: 50, // hedge if the primary hasn't answered in 50ms
        strategy: {
          mode: 'fallback',
          targets: [anthropicTarget('slow', slowUrl), anthropicTarget('fast', fastUrl)],
        },
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
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    // The slow socket's close event may land just after the client finishes;
    // wait briefly for it so the cancellation assertion is deterministic.
    const deadline = Date.now() + 1000;
    while (!slowAborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-target')).toBe('fast'); // the hedge won
    expect(text).toContain('message_start');
    expect(slowHit).toBe(true); // the primary WAS dispatched (then hedged)
    expect(slowResponded).toBe(false);
    expect(slowAborted).toBe(true); // ...and cancelled once the hedge won
    expect(ledger.entries).toHaveLength(1); // metered exactly once (the winner)
    expect(ledger.entries[0]?.cost.outputTokens).toBe(42);

    await app.close();
    await new Promise<void>((r) => slow.close(() => r()));
    await new Promise<void>((r) => fast.close(() => r()));
  });

  it('relays the last candidate real failover status (not a synthetic 502) when a hedge finds no usable response', async () => {
    // 2-candidate hedged route where BOTH branches return a failover status: the
    // client must still receive the last candidate's genuine upstream error
    // (status + body), the last-resort relay — not a synthetic gateway 502.
    const slow503 = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"overloaded_error","message":"primary 503"}}');
      }, 250);
    });
    await new Promise<void>((r) => slow503.listen(0, '127.0.0.1', r));
    const slow503Url = `http://127.0.0.1:${(slow503.address() as AddressInfo).port}`;
    const fast529 = http.createServer((req, res) => {
      req.resume();
      res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end('{"type":"error","error":{"type":"overloaded_error","message":"upstream 529"}}');
    });
    await new Promise<void>((r) => fast529.listen(0, '127.0.0.1', r));
    const fast529Url = `http://127.0.0.1:${(fast529.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        hedgeDelayMs: 50,
        strategy: {
          mode: 'fallback',
          targets: [anthropicTarget('primary', slow503Url), anthropicTarget('last', fast529Url)],
        },
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
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await res.text();

    expect(res.status).toBe(529); // the real provider error, not a synthetic 502
    expect(res.headers.get('x-gulley-target')).toBe('last');
    expect(text).toContain('upstream 529'); // the genuine upstream body is relayed

    await app.close();
    await new Promise<void>((r) => slow503.close(() => r()));
    await new Promise<void>((r) => fast529.close(() => r()));
  });

  it('does not fire the hedge when the primary answers within the delay', async () => {
    let secondaryHit = false;
    const secondary = http.createServer((req, res) => {
      secondaryHit = true;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(GOLDEN_SSE);
    });
    await new Promise<void>((r) => secondary.listen(0, '127.0.0.1', r));
    const secondaryUrl = `http://127.0.0.1:${(secondary.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        hedgeDelayMs: 300, // primary answers well within this
        strategy: {
          mode: 'fallback',
          targets: [
            anthropicTarget('primary', upstreamUrl),
            anthropicTarget('secondary', secondaryUrl),
          ],
        },
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
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-target')).toBe('primary');
    expect(secondaryHit).toBe(false); // hedge never fired — no wasted upstream call

    await app.close();
    await new Promise<void>((r) => secondary.close(() => r()));
  });

  it('routes a client path per-tenant: workspace B overrides the shared strategy', async () => {
    const store = new InMemoryKeyStore();
    const genA = generateVirtualKey(PEPPER);
    store.add({
      id: 'vk_a',
      keyPrefix: genA.keyPrefix,
      keyHash: genA.keyHash,
      orgId: 'org_1',
      workspaceId: 'ws_a',
      displayName: 'A',
      epoch: 0,
      disabled: false,
      expiresAt: null,
      allowedProviders: '*',
      allowedModels: '*',
    });
    const genB = generateVirtualKey(PEPPER);
    store.add({
      id: 'vk_b',
      keyPrefix: genB.keyPrefix,
      keyHash: genB.keyHash,
      orgId: 'org_1',
      workspaceId: 'ws_b',
      displayName: 'B',
      epoch: 0,
      disabled: false,
      expiresAt: null,
      allowedProviders: '*',
      allowedModels: '*',
    });

    const { ctx } = buildContext(store); // base route target = 'anthropic'
    ctx.tenantRoutes = new MapTenantRouteResolver(
      new Map([
        [
          'ws_b',
          new Map([
            [
              '/v1/messages',
              {
                strategy: {
                  mode: 'single' as const,
                  target: anthropicTarget('tenant-b-target', upstreamUrl),
                },
              },
            ],
          ]),
        ],
      ]),
    );
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const reqBody = JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const resA = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': genA.token },
      body: reqBody,
    });
    await resA.text();
    const resB = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': genB.token },
      body: reqBody,
    });
    await resB.text();
    // Sibling alias of the SAME route (indexed under both '/v1/messages' and
    // '/anthropic/v1/messages'): the override — keyed only under '/v1/messages' —
    // must still apply, so a client can't escape its tenant pin via the alias.
    const resBAlias = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': genB.token },
      body: reqBody,
    });
    await resBAlias.text();

    expect(resA.headers.get('x-gulley-target')).toBe('anthropic'); // shared route
    expect(resB.headers.get('x-gulley-target')).toBe('tenant-b-target'); // per-tenant override
    expect(resBAlias.headers.get('x-gulley-target')).toBe('tenant-b-target'); // alias honored

    await app.close();
  });

  const costTierPolicy = (over: Partial<SmartRoutingPolicy> = {}): SmartRoutingPolicy => ({
    name: 'cost',
    objective: 'cost-tier',
    classifier: { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 20 }] },
    categoryRoutes: { cheap: 'claude-haiku-4-5' },
    selector: {},
    ...over,
  });

  const smartReq = (content: string): string =>
    JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 10,
      messages: [{ role: 'user', content }],
    });

  it('smart routing rewrites the model by classified category, metered once', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger, requestLog, audit } = buildContext(store);
    ctx.smartRouter = buildSmartRouter([costTierPolicy()], ctx.routes);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    // A short prompt ⇒ rule 'cheap' ⇒ the model is rewritten before dispatch.
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'),
    });
    await res.text();

    // The upstream received the rewritten model, metered exactly once (single
    // teardown). received.body is the effective outbound request.
    expect(JSON.parse(received.body).model).toBe('claude-haiku-4-5');
    expect(ledger.entries).toHaveLength(1);
    expect(requestLog.entries).toHaveLength(1);
    expect(audit.rows).toHaveLength(1);

    await app.close();
  });

  it('smart routing abstains on no match and falls back to the original model', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    // No default category + a long prompt ⇒ the rule never fires ⇒ no decision.
    ctx.smartRouter = buildSmartRouter([costTierPolicy()], ctx.routes);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('this is a much longer prompt that exceeds the twenty character cap'),
    });
    await res.text();

    expect(JSON.parse(received.body).model).toBe('claude-sonnet-4-6'); // unchanged
    await app.close();
  });

  const scopedStore = (scope: {
    allowedProviders: readonly string[] | '*';
    allowedModels: readonly string[] | '*';
  }): { store: InMemoryKeyStore; token: string } => {
    const store = new InMemoryKeyStore();
    const gen = generateVirtualKey(PEPPER);
    store.add({
      id: 'vk_1',
      keyPrefix: gen.keyPrefix,
      keyHash: gen.keyHash,
      orgId: 'org_1',
      workspaceId: 'ws_1',
      displayName: 'scoped',
      epoch: 0,
      disabled: false,
      expiresAt: null,
      allowedProviders: scope.allowedProviders,
      allowedModels: scope.allowedModels,
    });
    return { store, token: gen.token };
  };

  it('downshifts the model to a cheaper one near the budget cap', async () => {
    const { store, token } = seededStore();
    const budgets = new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 10_000_000 }]]));
    await budgets.reserve('ws_1', 'seed', 8_200_000);
    await budgets.commit('ws_1', 'seed', 8_200_000); // 82% used — above the 0.8 threshold
    const { ctx } = buildContext(store);
    ctx.budgets = budgets;
    ctx.budgetDownshift = { threshold: 0.8, model: 'claude-haiku-4-5' };
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((r) => r.text());
    // Near the cap, the expensive model is rewritten to the cheaper one upstream.
    expect(JSON.parse(received.body).model).toBe('claude-haiku-4-5');
    await app.close();
  });

  it('reprices the worst-case for the downshifted model so its own cap admits', async () => {
    const { store, token } = seededStore();
    // Workspace 82% used (above the 0.8 downshift threshold). The CHEAP model's own
    // cap (1500 µUSD) admits haiku's worst-case (~528) but would REJECT opus's
    // worst-case (~2640). Pre-fix the per-model reserve used the stale opus worst-case
    // and 402'd exactly the traffic the downshift exists to keep flowing.
    const budgets = new InMemoryBudgetStore(
      new Map([
        ['ws_1', { capMicroUsd: 10_000_000 }],
        ['model:claude-haiku-4-5', { capMicroUsd: 1_500 }],
      ]),
    );
    await budgets.reserve('ws_1', 'seed', 8_200_000);
    await budgets.commit('ws_1', 'seed', 8_200_000);
    const { ctx } = buildContext(store);
    ctx.budgets = budgets;
    ctx.budgetDownshift = { threshold: 0.8, model: 'claude-haiku-4-5' };
    ctx.budgetModelCaps = new Set(['claude-haiku-4-5']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Admitted (not 402 on the cheap model's cap) AND downshifted upstream.
    expect(res.status).not.toBe(402);
    expect(JSON.parse(received.body).model).toBe('claude-haiku-4-5');
    await app.close();
  });

  it('flags an off-catalog model and (fail-closed) charges the worst-case', async () => {
    // A served model with no catalog price meters $0 by default — a silent budget
    // bypass. It is always observed (unpriced attribute); fail-closed charges the
    // worst-case reserve so it cannot slip the cap.
    const UNPRICED_SSE = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_u","model":"mystery-model-9","usage":{"input_tokens":50,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    const up = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        void b;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(UNPRICED_SSE);
      });
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    const upUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx, ledger, requestLog } = buildContext(store);
    ctx.meterFailClosedOnUnpriced = true;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', upUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'mystery-model-9',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((r) => r.text());

    // Observed: the unpriced attribute is on the request log regardless of the knob.
    expect(requestLog.entries[0]?.attributes?.['unpriced']).toBe(true);
    // Fail-closed: charged the worst-case reserve, not $0.
    expect(ledger.entries[0]?.costMicroUsd).toBeGreaterThan(0);
    await app.close();
    up.close();
  });

  it('runaway-agent guardrail: a per-session cap 402s a session over its budget', async () => {
    const { store, token } = seededStore();
    // A tiny per-session cap; the request's worst-case reservation exceeds it.
    const budgets = new InMemoryBudgetStore(
      new Map([['attr:session:sess1', { capMicroUsd: 100, periodSeconds: 86400 }]]),
    );
    const { ctx } = buildContext(store);
    ctx.budgets = budgets;
    ctx.attributionHeaders = ['x-gulley-session'];
    ctx.budgetAttrCaps = new Set(['session']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'x-gulley-session': 'sess1',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'loop' }],
      }),
    });
    expect(res.status).toBe(402);
    await app.close();
  });

  it('runaway-agent guardrail: a session under its cap is admitted and charged to its scope', async () => {
    const { store, token } = seededStore();
    const budgets = new InMemoryBudgetStore(
      new Map([['attr:session:sess2', { capMicroUsd: 10_000_000, periodSeconds: 86400 }]]),
    );
    const { ctx } = buildContext(store);
    ctx.budgets = budgets;
    ctx.attributionHeaders = ['x-gulley-session'];
    ctx.budgetAttrCaps = new Set(['session']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'x-gulley-session': 'sess2',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    // The session's own scope carries the committed spend (the runaway control's meter).
    expect(budgets.committed('attr:session:sess2')).toBeGreaterThan(0);
    await app.close();
  });

  it('runaway-agent guardrail: enforces on the counter-less resolver path (no seed map)', async () => {
    const { store, token } = seededStore();
    // Mirror the gateway's counter-less wiring: a resolver keyed by the attr KEY,
    // NOT a map pre-seeded with the full `attr:session:<value>` scope. Before the
    // fix the in-memory store consulted only a model-cap map, so attr caps silently
    // no-op'd here (fail-open) while enforcing under Redis.
    const attrCap = { capMicroUsd: 100, periodSeconds: 86_400 };
    const budgets = new InMemoryBudgetStore((scope) =>
      scope.startsWith('attr:session:') ? attrCap : null,
    );
    const { ctx } = buildContext(store);
    ctx.budgets = budgets;
    ctx.attributionHeaders = ['x-gulley-session'];
    ctx.budgetAttrCaps = new Set(['session']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'x-gulley-session': 'looping-agent',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'loop' }],
      }),
    });
    expect(res.status).toBe(402);
    await app.close();
  });

  it('drops an over-long or key-unsafe attribution value while keeping valid tags', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.attributionHeaders = ['x-gulley-session', 'x-gulley-repo', 'x-gulley-dev'];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        // Over the 128-char bound → dropped, so it can't mint a giant Redis key.
        'x-gulley-session': 'x'.repeat(200),
        // Contains a Redis hash-tag delimiter (`}`) → dropped, so it can't collide slots.
        'x-gulley-repo': 'acme/api}evil',
        // Valid and bounded → kept.
        'x-gulley-dev': 'alice',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((r) => r.text());
    // The hostile values are dropped (never attributed → never keyed as a counter);
    // the valid tag survives, so the bound is selective, not a blanket disable.
    const attrs = ledger.entries[0]?.attributes;
    expect(attrs?.['session']).toBeUndefined();
    expect(attrs?.['repo']).toBeUndefined();
    expect(attrs?.['dev']).toBe('alice');
    await app.close();
  });

  it('captures attribution headers onto the ledger without shadowing built-in facets', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger, requestLog } = buildContext(store);
    // Include a tag whose key COLLIDES with a built-in request-log facet (`target`).
    ctx.attributionHeaders = ['x-gulley-repo', 'x-gulley-dev', 'x-gulley-target'];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'x-gulley-repo': 'acme/api',
        'x-gulley-dev': 'alice',
        'x-gulley-target': 'staging', // a client value that must NOT shadow the real target
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }).then((r) => r.text());
    // The x-gulley- prefix is stripped; spend rolls up by these SDLC tags (ledger has
    // its own isolated attributes column, so all tags land verbatim).
    expect(ledger.entries[0]?.attributes).toEqual({
      repo: 'acme/api',
      dev: 'alice',
      target: 'staging',
    });
    // But in the flat request-log attributes, the authoritative built-in `target`
    // facet (the real upstream) wins over the colliding client tag.
    expect(requestLog.entries[0]?.attributes?.['target']).toBe('anthropic');
    expect(requestLog.entries[0]?.attributes?.['repo']).toBe('acme/api');
    await app.close();
  });

  it('caches a clean response even when output enforcement is on (coexistence)', async () => {
    // With an enforcing output policy, a CLEAN response (nothing to redact) is now
    // cacheable — the raw body IS the enforced body, so replay is safe. Previously
    // enforcement disabled caching entirely, gutting cache savings on DLP routes.
    const CLEAN_JSON = JSON.stringify({
      id: 'msg_c',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'the sky is blue' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    let upstreamCalls = 0;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        void b;
        upstreamCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(CLEAN_JSON);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const srvUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.cache = new CacheEngine({ exact: new InMemoryExactCache(), ttlSeconds: 60 });
    ctx.guardrails = new GuardrailEngine([new NativeDetector({})], {
      input: { action: 'audit' },
      output: { action: 'redact', minConfidence: 0.5 }, // enforcing (not audit)
    });
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', srvUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'why is the sky blue' }],
      }),
    };
    await fetch(`${base}/v1/messages`, opts).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40)); // let the store (in teardown) settle
    const second = await fetch(`${base}/v1/messages`, opts);
    await second.text();

    // Served from cache despite enforcement being on — the second never hit upstream.
    expect(second.headers.get('cache-status')).toContain('hit');
    expect(upstreamCalls).toBe(1);
    await app.close();
    srv.close();
  });

  it('does NOT cache an enforced response that had a finding (never serve un-enforced content)', async () => {
    // A response carrying a secret is redacted by enforcement; it must NOT be cached,
    // or a cache hit would replay the RAW (un-redacted) body serveFromCache stores.
    const SECRET_JSON = JSON.stringify({
      id: 'msg_s',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'your key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    let upstreamCalls = 0;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        void b;
        upstreamCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(SECRET_JSON);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const srvUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.cache = new CacheEngine({ exact: new InMemoryExactCache(), ttlSeconds: 60 });
    ctx.guardrails = new GuardrailEngine([new NativeDetector({})], {
      input: { action: 'audit' },
      output: { action: 'redact', minConfidence: 0.5 },
    });
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', srvUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'what is my key' }],
      }),
    };
    await fetch(`${base}/v1/messages`, opts).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const second = await fetch(`${base}/v1/messages`, opts);
    await second.text();

    // A response with a finding under enforcement is never cached — upstream re-hit.
    expect(second.headers.get('cache-status') ?? '').not.toContain('hit');
    expect(upstreamCalls).toBe(2);
    await app.close();
    srv.close();
  });

  it('does NOT cache a plugin-masked response that reported zero findings', async () => {
    // Defense-in-depth: an output guardrail PLUGIN can mask a body while returning an
    // empty findings array, so a findings-count check alone would wrongly cache the
    // RAW (un-sanitized) body. The store gate also requires no transform was applied.
    const CLEAN_JSON = JSON.stringify({
      id: 'msg_p',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'internal system detail' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    let upstreamCalls = 0;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString('utf8')));
      req.on('end', () => {
        void b;
        upstreamCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(CLEAN_JSON);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const srvUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    // A plugin that masks the output but reports NO structured findings.
    const emptyFindingMaskPlugin = {
      name: 'test-mask',
      inspect: async (_text: string, direction: 'input' | 'output') =>
        direction === 'output'
          ? { action: 'masked' as const, maskedText: '[sanitized]', findings: [] }
          : { action: 'none' as const, findings: [] },
    };

    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.cache = new CacheEngine({ exact: new InMemoryExactCache(), ttlSeconds: 60 });
    ctx.guardrails = new GuardrailEngine(
      [new NativeDetector({})],
      { input: { action: 'audit' }, output: { action: 'redact', minConfidence: 0.5 } },
      emptyFindingMaskPlugin,
    );
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', srvUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'tell me the detail' }],
      }),
    };
    await fetch(`${base}/v1/messages`, opts).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 40));
    const second = await fetch(`${base}/v1/messages`, opts);
    await second.text();

    // The plugin masked the body (transform applied), so the raw body is NOT cached.
    expect(second.headers.get('cache-status') ?? '').not.toContain('hit');
    expect(upstreamCalls).toBe(2);
    await app.close();
    srv.close();
  });

  it('504s when the pre-first-byte deadline elapses before the first byte', async () => {
    // An upstream that never returns headers within the deadline: the gateway aborts
    // the dispatch phase and returns a 504 rather than pinning the request.
    const timers: NodeJS.Timeout[] = [];
    const slow = http.createServer((req, res) => {
      req.resume();
      // Respond far later than the deadline; the gateway aborts long before this.
      timers.push(setTimeout(() => res.writeHead(200).end('{}'), 5000));
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;

    const { store, token } = seededStore();
    const { ctx, breaker } = buildContext(store);
    const failSpy = vi.spyOn(breaker, 'recordFailure');
    ctx.requestDeadlineMs = 120; // pre-first-byte budget
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('anthropic', slowUrl) },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [] }),
    });
    await res.text();
    expect(res.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(2000); // aborted near the deadline, not at 5s
    // A gateway deadline is NOT an upstream fault — the breaker must not be blamed.
    expect(failSpy).not.toHaveBeenCalled();
    for (const t of timers) clearTimeout(t);
    await app.close();
    slow.close();
  });

  const openaiRoute = (): ProviderRoute => ({
    clientPaths: ['/v1/chat/completions'],
    createExtractor: () => new OpenAIUsageExtractor(),
    strategy: {
      mode: 'single',
      target: {
        name: 'openai',
        provider: 'openai',
        adapter: new AnthropicAdapter({ baseUrl: upstreamUrl }), // never invoked (403)
        credential: { scheme: 'bearer', value: UPSTREAM_KEY },
        upstreamPath: '/v1/messages',
      },
    },
  });

  it('deny-by-default authz still filters a smart-rerouted MODEL', async () => {
    // Key allows the requested model but NOT the category's target model.
    const { store, token } = scopedStore({
      allowedProviders: '*',
      allowedModels: ['claude-sonnet-4-6'],
    });
    const { ctx, requestLog } = buildContext(store);
    ctx.smartRouter = buildSmartRouter([costTierPolicy()], ctx.routes); // 'hi' → claude-haiku-4-5
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'model not permitted',
    );
    expect(requestLog.entries).toHaveLength(0); // never dispatched
    await app.close();
  });

  it('deny-by-default authz still filters a smart-rerouted PROVIDER', async () => {
    // Key allows only anthropic; a policy reroutes 'cheap' to openai.
    const { store, token } = scopedStore({ allowedProviders: ['anthropic'], allowedModels: '*' });
    const { ctx, requestLog } = buildContext(store);
    ctx.routes.push(openaiRoute()); // so the reroute resolves
    ctx.smartRouter = buildSmartRouter(
      [costTierPolicy({ categoryRoutes: { cheap: 'openai:gpt-4o' } })],
      ctx.routes,
    );
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'), // 'hi' → cheap → openai:gpt-4o (a disallowed provider)
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'not permitted',
    );
    expect(requestLog.entries).toHaveLength(0);
    await app.close();
  });

  it('a per-tenant residency pin preempts smart routing entirely', async () => {
    const { store, token } = seededStore(); // workspace ws_1
    const { ctx } = buildContext(store);
    // Both are wired; the tenant pin must win AND smart routing must not run (so
    // the model is NOT rewritten) — residency-first.
    ctx.tenantRoutes = new MapTenantRouteResolver(
      new Map([
        [
          'ws_1',
          new Map([
            [
              '/v1/messages',
              {
                strategy: {
                  mode: 'single' as const,
                  target: anthropicTarget('pinned', upstreamUrl),
                },
              },
            ],
          ]),
        ],
      ]),
    );
    ctx.smartRouter = buildSmartRouter([costTierPolicy()], ctx.routes);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'), // would classify 'cheap' if smart routing ran
    });
    await res.text();

    expect(res.headers.get('x-gulley-target')).toBe('pinned'); // tenant pin served
    expect(JSON.parse(received.body).model).toBe('claude-sonnet-4-6'); // NOT rewritten
    await app.close();
  });

  // A classifier completer that never touches the network — returns a fixed
  // category label + usage, so the metering path can be exercised deterministically.
  const fakeCompleter = (usage?: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): ClassifierCompleter => ({
    complete: async () => (usage ? { text: 'cheap', usage } : { text: 'cheap' }),
  });

  const llmPolicy = (meterClassifier: boolean): SmartRoutingPolicy => ({
    name: 'route-by-llm',
    objective: 'domain-skill',
    classifier: {
      mode: 'llm-router',
      model: 'router-x',
      providerRef: 'anthropic',
      meterClassifier,
    },
    categoryRoutes: { cheap: 'claude-haiku-4-5' },
    selector: {},
  });

  it('meters a classifier sub-call as its own proxy.classify line when meterClassifier is on', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger, audit } = buildContext(store);
    ctx.smartRouter = buildSmartRouter([llmPolicy(true)], ctx.routes, {
      completer: fakeCompleter({
        provider: 'anthropic',
        model: 'router-x',
        inputTokens: 20,
        outputTokens: 1,
      }),
    });
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'),
    });
    await res.text();
    // The classifier sub-meter is fire-and-forget (off the served critical path);
    // let it flush before asserting its durable side-effects.
    await new Promise((r) => setTimeout(r, 20));

    // The reroute took effect (upstream saw the rewritten model)...
    expect(JSON.parse(received.body).model).toBe('claude-haiku-4-5');
    // ...and the classifier sub-call is metered on its own #classify line, distinct
    // from the served request's single teardown.
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['proxy.classify', 'proxy.request']);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.some((e) => e.requestId.endsWith('#classify'))).toBe(true);
    const classifyLine = ledger.entries.find((e) => e.requestId.endsWith('#classify'));
    expect(classifyLine?.model).toBe('router-x');

    await app.close();
  });

  it('does not meter the classifier when meterClassifier is off (reroute still applies)', async () => {
    const { store, token } = seededStore();
    const { ctx, ledger, audit } = buildContext(store);
    ctx.smartRouter = buildSmartRouter([llmPolicy(false)], ctx.routes, {
      completer: fakeCompleter({
        provider: 'anthropic',
        model: 'router-x',
        inputTokens: 20,
        outputTokens: 1,
      }),
    });
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: smartReq('hi'),
    });
    await res.text();

    expect(JSON.parse(received.body).model).toBe('claude-haiku-4-5'); // still rerouted
    expect(audit.rows.map((r) => r.action)).toEqual(['proxy.request']); // no classify line
    expect(ledger.entries).toHaveLength(1);

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

  it('multi-level: a per-model cap rejects with the workspace reservation rolled back', async () => {
    const { store, token } = seededStore();
    // Workspace cap is generous (admits), but the per-model cap for opus is tiny —
    // max_tokens=1000 reserves well over 500 microUSD against `model:…`, so the
    // model level rejects even though the workspace level admitted.
    const budgets = new InMemoryBudgetStore(
      new Map([
        ['ws_1', { capMicroUsd: 10_000_000 }],
        ['model:claude-opus-4-8', { capMicroUsd: 500 }],
      ]),
    );
    const { ctx, requestLog } = buildContext(store, budgets);
    ctx.budgetModelCaps = new Set(['claude-opus-4-8']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('budget_exceeded');
    expect(requestLog.entries).toHaveLength(0); // never dispatched

    // The workspace reservation must have been released on the model-level rejection:
    // a probe reserving the FULL workspace cap succeeds only if nothing is leaked.
    const probe = await budgets.reserve('ws_1', 'probe', 10_000_000);
    expect(probe?.allowed).toBe(true);
    await app.close();
  });

  it('multi-level: within both caps, teardown commits the actual to workspace AND model', async () => {
    const { store, token } = seededStore();
    const budgets = new InMemoryBudgetStore(
      new Map([
        ['ws_1', { capMicroUsd: 10_000_000 }],
        ['model:claude-opus-4-8', { capMicroUsd: 10_000_000 }],
      ]),
    );
    const { ctx } = buildContext(store, budgets);
    ctx.budgetModelCaps = new Set(['claude-opus-4-8']);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain so teardown runs

    const wsSpend = budgets.committed('ws_1');
    const modelSpend = budgets.committed('model:claude-opus-4-8');
    expect(wsSpend).toBeGreaterThan(0);
    expect(modelSpend).toBe(wsSpend); // same actual charged to every reserved scope
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

  // Build an Anthropic-canonical SSE stream from a list of text_delta payloads.
  const anthropicSse = (deltas: string[], outputTokens = 9): string => {
    const delta = (text: string): string =>
      'event: content_block_delta\ndata: ' +
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }) +
      '\n\n';
    return (
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":7}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n' +
      deltas.map(delta).join('') +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      `event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":${outputTokens}}}\n\n` +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    );
  };

  const streamEnforceRoute = async (
    deltas: string[],
    action: 'redact' | 'block',
  ): Promise<{
    app: Awaited<ReturnType<typeof buildServer>>;
    base: string;
    server: http.Server;
    ledger: InMemoryLedger;
    token: string;
  }> => {
    const body = anthropicSse(deltas);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.streamEnforce = true;
    ctx.streamEnforceWindowChars = 32;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('enforce', url) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action, minConfidence: 0.5 },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    return { app, base, server, ledger, token };
  };

  const streamReqBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });

  // The logical assistant text the CLIENT reassembles from the (possibly
  // re-framed) text_delta events — what stream-enforce actually redacts.
  const clientText = (sse: string): string =>
    new SSEParser()
      .push(sse)
      .flatMap((e) => {
        try {
          const d = JSON.parse(e.data) as { delta?: { type?: string; text?: string } };
          return d.delta?.type === 'text_delta' && typeof d.delta.text === 'string'
            ? [d.delta.text]
            : [];
        } catch {
          return [];
        }
      })
      .join('');

  it('enforces output guardrails on a /v1/responses stream — deltas AND echoes redacted', async () => {
    // A Responses stream: text deltas, then the echoing output_text.done +
    // content_part.done + response.completed frames that most SDKs read the final
    // message from. Enforcement must redact the email in ALL of them (echo-leak guard).
    const rframe = (event: string, obj: unknown): string =>
      `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
    const full = 'email me at leak@example.com please';
    const body =
      rframe('response.created', { type: 'response.created', response: { id: 'resp_1' } }) +
      rframe('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: full,
        // per-token logprobs echo the raw text — must be stripped under enforcement
        logprobs: [
          { token: 'leak@example', logprob: -0.1 },
          { token: '.com', logprob: -0.2 },
        ],
      }) +
      rframe('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        text: full,
        logprobs: [{ token: 'leak@example.com', logprob: -0.1 }],
      }) +
      rframe('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: full, annotations: [] },
      }) +
      // The materialized item echo — the frame that leaked before the fix.
      rframe('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: full, annotations: [] }],
        },
      }) +
      rframe('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: full, annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 8 },
        },
      });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.streamEnforce = true;
    ctx.streamEnforceWindowChars = 32;
    ctx.routes = [
      {
        clientPaths: ['/v1/responses'],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: 'responses',
            provider: 'openai',
            adapter: new AnthropicAdapter({ baseUrl: url }),
            credential: { scheme: 'bearer', value: UPSTREAM_KEY },
            upstreamPath: '/v1/responses',
          },
        },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action: 'redact', minConfidence: 0.5 },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const out = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'gpt-5', stream: true, input: 'hi' }),
    }).then((r) => r.text());

    const evs = new SSEParser().push(out).map((e) => JSON.parse(e.data) as Record<string, unknown>);
    // No frame — delta OR echo — may leak the raw email.
    expect(out).not.toContain('leak@example.com');
    // deltas were redacted (some output_text.delta emitted, redacted)
    const deltaText = evs
      .filter((e) => e['type'] === 'response.output_text.delta')
      .map((e) => e['delta'])
      .join('');
    expect(deltaText).not.toContain('leak@example.com');
    expect(deltaText.length).toBeGreaterThan(0);
    // the completed echo carries the SAME redacted text, and usage is intact
    const completed = evs.find((e) => e['type'] === 'response.completed');
    const resp = completed?.['response'] as Record<string, unknown>;
    const block = (
      (resp['output'] as Record<string, unknown>[])[0]!['content'] as Record<string, unknown>[]
    )[0]!;
    expect(String(block['text'])).toBe(deltaText); // echo == accumulator
    expect(resp['usage']).toEqual({ input_tokens: 5, output_tokens: 8 });
    // the output_item.done item echo is scrubbed too (the frame that leaked pre-fix)
    const item = evs.find((e) => e['type'] === 'response.output_item.done');
    const itemBlock = (
      (item?.['item'] as Record<string, unknown>)['content'] as Record<string, unknown>[]
    )[0]!;
    expect(String(itemBlock['text'])).toBe(deltaText);
    // per-token logprobs (which spell out the raw text) are stripped from the stream
    expect(out).not.toContain('logprobs');

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('masks input PII to the provider and detokenizes it back to the client (input vault)', async () => {
    // Upstream echoes the (masked) prompt text back so the response-side detok can
    // restore it — proving the full mask→provider→detokenize→client round-trip.
    let upstreamBody = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        upstreamBody = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(upstreamBody) as { messages?: Array<{ content?: string }> };
        const echoed = body.messages?.[0]?.content ?? '';
        const sse =
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n' +
          'event: content_block_delta\ndata: ' +
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: echoed },
          }) +
          '\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('mask', url) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'mask', minConfidence: 0.5 },
          output: { action: 'audit' },
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
        stream: true,
        messages: [{ role: 'user', content: 'contact jane@example.com please' }],
      }),
    });
    const text = await res.text();

    // The provider saw the masked token, not the raw email; the client sees it restored.
    expect(upstreamBody).not.toContain('jane@example.com');
    expect(upstreamBody).toContain('<<GULLEY_EMAIL_');
    expect(clientText(text)).toContain('jane@example.com');

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('persists an encrypted mask-vault record in teardown (never plaintext) (M22 D)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    const cipher = new InMemoryAesCipher();
    const records: MaskVaultRecord[] = [];
    ctx.maskVault = {
      put: async (r) => {
        records.push(r);
      },
      get: async () => undefined,
      list: async () => [],
      sweepExpired: async () => 0,
    };
    ctx.maskVaultEncryptor = cipher;
    ctx.maskVaultTtlSeconds = 3600;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('mask', url) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'mask', minConfidence: 0.5 },
          output: { action: 'audit' },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const requestId = 'itest-mask-req';
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token, 'request-id': requestId },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'contact jane@example.com please' }],
      }),
    }).then((r) => r.text());

    // Exactly one input-direction record, encrypted (envelope shape, no plaintext).
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.direction).toBe('input');
    expect(rec.tokenCount).toBeGreaterThan(0);
    expect(rec.workspaceId).toBe('ws_1');
    expect(JSON.stringify(rec.ciphertext)).not.toContain('jane@example.com'); // never plaintext
    // Decrypt with the same key + AAD → the original token↔value map is recovered.
    const bytes = await cipher.decrypt(rec.ciphertext as Parameters<typeof cipher.decrypt>[0], {
      aad: `${rec.requestId}:${rec.workspaceId}:input`,
    });
    const entries = JSON.parse(Buffer.from(bytes).toString('utf8')) as Array<[string, string]>;
    expect(entries.some(([, original]) => original === 'jane@example.com')).toBe(true);

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('swallows a mask-vault persist failure — the request still succeeds + meters (M22 D)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    // An encryptor that always throws — the persist must fail-open (best-effort).
    ctx.maskVault = {
      put: async () => {},
      get: async () => undefined,
      list: async () => [],
      sweepExpired: async () => 0,
    };
    ctx.maskVaultEncryptor = {
      encrypt: async () => {
        throw new Error('kms unavailable');
      },
      decrypt: async () => new Uint8Array(),
    };
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('mask', url) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'mask', minConfidence: 0.5 },
          output: { action: 'audit' },
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
        stream: true,
        messages: [{ role: 'user', content: 'contact jane@example.com please' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // Teardown completed despite the persist throw: the request was metered.
    expect(ledger.entries).toHaveLength(1);

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('charges worst-case when a 2xx stream emits no usage and the knob is on', async () => {
    // An OpenAI-compatible stream with NO usage chunk (the backend didn't set
    // stream_options.include_usage). seen stays false → without the knob this bills
    // $0 and fully refunds the reservation, leaving the budget unenforced.
    const body =
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
      'data: {"id":"c","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.chargeOnMissingUsage = true;
    ctx.routes = [
      {
        clientPaths: ['/v1/chat/completions'],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: 'nousage',
            provider: 'openai',
            adapter: new AnthropicAdapter({ baseUrl: url }),
            credential: { scheme: 'bearer', value: UPSTREAM_KEY },
            upstreamPath: '/v1/chat/completions',
          },
        },
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();

    expect(ledger.entries).toHaveLength(1); // charged despite no usage frame
    expect(ledger.entries[0]?.costMicroUsd).toBeGreaterThan(0); // worst-case, not $0

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('redacts a secret in a streamed Anthropic response (windowed in-stream enforcement)', async () => {
    const { app, base, server, ledger, token } = await streamEnforceRoute(
      [
        'Here is a long clean intro with nothing sensitive at all. The key is AKIA',
        'IOSFODNN7EXAMPLE and here is clean trailing text continuing well past the window.',
      ],
      'redact',
    );
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: streamReqBody,
    });
    const text = await res.text();

    const ct = clientText(text);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-guardrail')).toBe('stream-enforce');
    expect(ct).not.toContain('AKIAIOSFODNN7EXAMPLE'); // the secret is redacted mid-stream
    expect(ct).toContain('<<REDACTED_AWS_ACCESS_KEY_ID>>');
    expect(ct).toContain('Here is a long clean intro'); // clean prefix delivered
    expect(ct).toContain('clean trailing text'); // clean suffix delivered
    expect(ledger.entries).toHaveLength(1); // single teardown
    expect(ledger.entries[0]?.cost.outputTokens).toBe(9); // metered from ORIGINAL frames

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('enforces in-stream via a per-route streamEnforce flag (DLP default-on, global toggle off)', async () => {
    // Same windowed redaction, but driven by route.streamEnforce (what the
    // per-workspace guardrail wiring sets) with the GLOBAL ctx.streamEnforce OFF —
    // so a DB-configured DLP policy enforces on streamed responses by default
    // instead of silently degrading to audit-only.
    const body = anthropicSse([
      'Here is a long clean intro with nothing sensitive at all. The key is AKIA',
      'IOSFODNN7EXAMPLE and here is clean trailing text continuing well past the window.',
    ]);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    expect(ctx.streamEnforce).not.toBe(true); // the GLOBAL toggle is off
    ctx.streamEnforceWindowChars = 32;
    ctx.routes = [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: { mode: 'single', target: anthropicTarget('enforce', url) },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action: 'redact', minConfidence: 0.5 },
        }),
        streamEnforce: true, // per-route opt-in (set by the per-workspace wiring)
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: streamReqBody,
    });
    const ct = clientText(await res.text());
    expect(res.headers.get('x-gulley-guardrail')).toBe('stream-enforce');
    expect(ct).not.toContain('AKIAIOSFODNN7EXAMPLE'); // redacted mid-stream despite global off
    expect(ct).toContain('<<REDACTED_AWS_ACCESS_KEY_ID>>');
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('blocks a streamed response at the first violation (terminal error, secret withheld)', async () => {
    const { app, base, server, ledger, token } = await streamEnforceRoute(
      [
        'A clean opening sentence with nothing to hide here at all. Then the key is AKIA',
        'IOSFODNN7EXAMPLE plus a good amount of clean trailing text past the window edge.',
      ],
      'block',
    );
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: streamReqBody,
    });
    const text = await res.text();

    expect(clientText(text)).toContain('A clean opening'); // clean prefix streamed before the block
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE'); // the secret is never emitted
    expect(text).toContain('event: error'); // terminal SSE error frame
    expect(ledger.entries).toHaveLength(1); // single teardown even on a mid-stream block

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('passes a clean streamed response through unchanged under stream-enforce', async () => {
    const { app, base, server, ledger, token } = await streamEnforceRoute(
      ['This is a perfectly clean response with no sensitive data whatsoever, all good.'],
      'redact',
    );
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: streamReqBody,
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-guardrail')).toBe('stream-enforce');
    // The client reassembles the clean text byte-for-byte (no redaction).
    expect(clientText(text)).toBe(
      'This is a perfectly clean response with no sensitive data whatsoever, all good.',
    );
    expect(text).not.toContain('REDACTED');
    expect(ledger.entries).toHaveLength(1);

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  // --- M17 non-Anthropic re-framing: the OpenAI chat.completions stream shape ---

  const openaiSse = (contents: string[], outputTokens = 9): string => {
    const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const content = (text: string): string =>
      chunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    return (
      chunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      contents.map(content).join('') +
      chunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: outputTokens } }) +
      'data: [DONE]\n\n'
    );
  };

  const openaiClientText = (sse: string): string =>
    new SSEParser()
      .push(sse)
      .flatMap((e) => {
        if (e.data === '[DONE]') return [];
        try {
          const d = JSON.parse(e.data) as { choices?: Array<{ delta?: { content?: string } }> };
          return (d.choices ?? [])
            .map((c) => c.delta?.content)
            .filter((x): x is string => typeof x === 'string');
        } catch {
          return [];
        }
      })
      .join('');

  const openaiStreamEnforceRoute = async (
    contents: string[],
    action: 'redact' | 'block' | 'mask',
  ): Promise<{
    app: Awaited<ReturnType<typeof buildServer>>;
    base: string;
    server: http.Server;
    ledger: InMemoryLedger;
    token: string;
  }> => {
    const body = openaiSse(contents);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.streamEnforce = true;
    ctx.streamEnforceWindowChars = 32;
    ctx.routes = [
      {
        clientPaths: ['/v1/chat/completions'],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: 'oai',
            provider: 'openai',
            adapter: new AnthropicAdapter({ baseUrl: url }), // passthrough to the canned server
            credential: { scheme: 'bearer', value: UPSTREAM_KEY },
            upstreamPath: '/v1/chat/completions',
          },
        },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action, minConfidence: 0.5 },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    return { app, base, server, ledger, token };
  };

  const openaiReqBody = JSON.stringify({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });

  it('redacts a secret in a streamed OpenAI chat.completions response', async () => {
    const { app, base, server, ledger, token } = await openaiStreamEnforceRoute(
      [
        'Here is a long clean intro with nothing sensitive at all. The key is AKIA',
        'IOSFODNN7EXAMPLE and here is clean trailing text continuing well past the window.',
      ],
      'redact',
    );
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: openaiReqBody,
    });
    const text = await res.text();
    const ct = openaiClientText(text);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gulley-guardrail')).toBe('stream-enforce');
    expect(ct).not.toContain('AKIAIOSFODNN7EXAMPLE'); // secret redacted mid-stream
    expect(ct).toContain('<<REDACTED_AWS_ACCESS_KEY_ID>>');
    expect(ct).toContain('Here is a long clean intro'); // clean prefix delivered
    expect(ct).toContain('clean trailing text'); // clean suffix delivered
    expect(text).toContain('[DONE]'); // terminator preserved
    expect(text).toContain('"usage"'); // usage frame preserved
    expect(ledger.entries).toHaveLength(1); // single teardown
    expect(ledger.entries[0]?.cost.outputTokens).toBe(9); // metered from ORIGINAL frames

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reversibly masks a secret in a streamed OpenAI response (client gets stable tokens)', async () => {
    const { app, base, server, ledger, token } = await openaiStreamEnforceRoute(
      [
        'Clean intro text that comfortably exceeds the hold window here. Contact jane@examp',
        'le.com now and then jane@example.com again, plus clean trailing text past the edge.',
      ],
      'mask',
    );
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: openaiReqBody,
    });
    const text = await res.text();
    const ct = openaiClientText(text);

    expect(res.status).toBe(200);
    expect(ct).not.toContain('jane@example.com'); // raw value never reaches the client
    const tokens = [...ct.matchAll(/<<GULLEY_EMAIL_\d+>>/g)].map((m) => m[0]);
    expect(tokens.length).toBe(2); // both occurrences tokenized
    expect(tokens[0]).toBe(tokens[1]); // stable token (coreference preserved)
    expect(ledger.entries).toHaveLength(1);

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('blocks a streamed OpenAI response with an OpenAI-dialect terminal error', async () => {
    const { app, base, server, ledger, token } = await openaiStreamEnforceRoute(
      [
        'A clean opening sentence with nothing to hide here at all. Then the key is AKIA',
        'IOSFODNN7EXAMPLE plus a good amount of clean trailing text past the window edge.',
      ],
      'block',
    );
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: openaiReqBody,
    });
    const text = await res.text();

    expect(openaiClientText(text)).toContain('A clean opening'); // clean prefix streamed
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE'); // secret never emitted
    expect(text).toContain('"type":"api_error"'); // OpenAI-shaped terminal error
    expect(text).not.toContain('event: error'); // NOT the Anthropic dialect
    expect(ledger.entries).toHaveLength(1); // single teardown even on a mid-stream block

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fails closed on a multi-choice (n>1) OpenAI stream instead of corrupting text', async () => {
    const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const body =
      chunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, delta: { content: 'Hello from choice zero here.' }, finish_reason: null },
        ],
      }) +
      chunk({
        id: 'c',
        object: 'chat.completion.chunk',
        model: 'gpt-4o-mini',
        choices: [
          { index: 1, delta: { content: 'Bonjour depuis le choix un.' }, finish_reason: null },
        ],
      }) +
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }) +
      'data: [DONE]\n\n';
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { store, token } = seededStore();
    const { ctx, ledger } = buildContext(store);
    ctx.streamEnforce = true;
    ctx.streamEnforceWindowChars = 32;
    ctx.routes = [
      {
        clientPaths: ['/v1/chat/completions'],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: 'oai',
            provider: 'openai',
            adapter: new AnthropicAdapter({ baseUrl: url }),
            credential: { scheme: 'bearer', value: UPSTREAM_KEY },
            upstreamPath: '/v1/chat/completions',
          },
        },
        guardrails: new GuardrailEngine([new NativeDetector({})], {
          input: { action: 'audit' },
          output: { action: 'redact', minConfidence: 0.5 },
        }),
      },
    ];
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: openaiReqBody,
    });
    const text = await res.text();

    expect(text).not.toContain('Bonjour depuis le choix un'); // 2nd choice never corrupts/leaks
    expect(text).toContain('"type":"api_error"'); // OpenAI-dialect terminal error
    expect(ledger.entries).toHaveLength(1); // single teardown

    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
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
    const { ctx, ledger } = buildContext(store);
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
    // Metering couldn't parse the over-cap body, but the provider billed it — the
    // worst-case reservation is charged (a ledger row with a non-zero cost), so a
    // withheld over-cap response can't be used to evade the budget.
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.costMicroUsd ?? 0).toBeGreaterThan(0);

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

  it('streams the live request tracer over SSE (token-guarded)', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.tracer = new RequestTracer(50);
    ctx.debugTraceToken = 'trace-secret';
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    // Unauthenticated → 401.
    const anon = await fetch(`${base}/debug/trace`);
    expect(anon.status).toBe(401);

    // Make a proxied request so the tracer records an event.
    await (
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': token },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    ).text();

    // Connect to the SSE stream; the ring replays the recorded event immediately.
    const ac = new AbortController();
    const stream = await fetch(`${base}/debug/trace`, {
      headers: { authorization: 'Bearer trace-secret' },
      signal: ac.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    ac.abort();
    expect(chunk).toContain('data:');
    expect(chunk).toContain('"provider":"anthropic"');
    expect(chunk).not.toContain(token); // credential-free

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

  it("forwards with the tenant's own upstream credential (multi-tenant isolation)", async () => {
    const { store, token } = seededStore(); // virtual key is in workspace ws_1
    const { ctx } = buildContext(store);
    ctx.tenantCredentials = new MapTenantCredentialResolver(
      new Map([['ws_1', new Map([['anthropic', { scheme: 'x-api-key', value: 'tenant-1-key' }]])]]),
    );
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    await (
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': token },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    ).text();

    // The gateway's default upstream key is UPSTREAM_KEY; ws_1's tenant key wins.
    expect(received.apiKey).toBe('tenant-1-key');
    expect(received.apiKey).not.toBe(UPSTREAM_KEY);

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

function restrictedStore(allowedModels: readonly string[] | '*'): {
  store: InMemoryKeyStore;
  token: string;
} {
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_1',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'restricted',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels,
  });
  return { store, token: gen.token };
}

interface PlaygroundResult {
  ok: boolean;
  model: { requested: string; resolved: string };
  authz: { modelAllowed: boolean; providerAllowed: boolean; provider?: string };
  route: { target: string; provider: string; upstreamPath: string } | null;
  guardrails:
    | { enabled: false }
    | { enabled: true; findings: number; categories: Record<string, number>; wouldBlock: boolean };
  cost: { estimatedWorstCaseMicroUsd: number };
  budget: { checked: boolean; allowed?: boolean; capMicroUsd?: number; usedMicroUsd?: number };
}

describe('POST /v1/playground/verify (preflight, no upstream spend)', () => {
  const verify = async (
    base: string,
    token: string | undefined,
    body: unknown,
  ): Promise<Response> =>
    fetch(`${base}/v1/playground/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-api-key': token } : {}),
      },
      body: JSON.stringify(body),
    });

  it('reports a working key/route/model without calling upstream', async () => {
    const { store, token } = seededStore();
    const { ctx, requestLog } = buildContext(store);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await verify(base, token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as PlaygroundResult;
    expect(json.ok).toBe(true);
    expect(json.authz.modelAllowed).toBe(true);
    expect(json.authz.providerAllowed).toBe(true);
    expect(json.route).toEqual({
      target: 'anthropic',
      provider: 'anthropic',
      upstreamPath: '/v1/messages',
    });
    expect(json.cost.estimatedWorstCaseMicroUsd).toBeGreaterThan(0);
    expect(requestLog.entries).toHaveLength(0); // never proxied
    await app.close();
  });

  it('401s an invalid key', async () => {
    const { store } = seededStore();
    const { ctx } = buildContext(store);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await verify(base, 'gk_not_a_real_key', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
    await app.close();
  });

  it('reports ok:false when the model is out of the key scope', async () => {
    const { store, token } = restrictedStore(['claude-haiku-4-5']);
    const { ctx } = buildContext(store);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await verify(base, token, {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const json = (await res.json()) as PlaygroundResult;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.authz.modelAllowed).toBe(false);
    expect(json.route).toBeNull();
    await app.close();
  });

  it('peeks the budget and rolls the reservation back (no net spend)', async () => {
    const { store, token } = seededStore();
    // Tiny cap so the worst-case can't fit: budget.allowed must be false.
    const budgets = new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 500 }]]));
    const { ctx } = buildContext(store, budgets);
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await verify(base, token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const json = (await res.json()) as PlaygroundResult;
    expect(json.budget.checked).toBe(true);
    expect(json.budget.allowed).toBe(false);
    expect(json.ok).toBe(false);

    // The peek must not have leaked a reservation: committed stays 0 and a fresh
    // reserve of the whole cap still succeeds.
    expect(budgets.committed('ws_1')).toBe(0);
    const probe = await budgets.reserve('ws_1', 'probe', 500);
    expect(probe?.allowed).toBe(true);
    await app.close();
  });

  it('surfaces a would-block guardrail verdict', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.guardrails = new GuardrailEngine([new NativeDetector({})], {
      input: { action: 'block' },
      output: { action: 'audit' },
    });
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await verify(base, token, {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'my email is test@example.com and SSN 123-45-6789' }],
    });
    const json = (await res.json()) as PlaygroundResult;
    expect(json.guardrails.enabled).toBe(true);
    if (json.guardrails.enabled) {
      expect(json.guardrails.findings).toBeGreaterThan(0);
      expect(json.guardrails.wouldBlock).toBe(true);
    }
    expect(json.ok).toBe(false);
    await app.close();
  });

  it('404s when the playground is disabled', async () => {
    const { store, token } = seededStore();
    const { ctx } = buildContext(store);
    ctx.playgroundEnabled = false;
    const app = buildServer(testConfig(), ctx);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await verify(base, token, {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(404);
    await app.close();
  });
});

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
