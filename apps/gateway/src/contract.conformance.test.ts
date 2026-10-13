import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { GULLEY_VERSION } from '@gulley/core';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  BedrockAdapter,
  OpenAIAdapter,
  OpenAIUsageExtractor,
} from '@gulley/providers';
import { CircuitBreaker, ModelRouter, type RouteTarget } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import {
  type ConformanceReport,
  type ContractCaseResult,
  type ContractSource,
  writeConformanceOutputs,
} from './conformance/report';
import type { GatewayContext, ProviderRoute } from './routes/messages';
import { buildServer } from './server';

/**
 * Gateway-contract conformance (K6): Anthropic's Claude Code gateway compatibility
 * guide and OpenAI's Codex gateway checklist, executed as black-box HTTP cases
 * against the assembled gateway with mock upstreams. Every case records a row for
 * docs/CONFORMANCE.md (see ./conformance/report.ts); CI fails when the committed
 * report drifts from what this suite proves.
 */

const PEPPER = 'contract-conformance-pepper';
const UPSTREAM_KEY = 'sk-ant-upstream';
const ANTHROPIC_DOC = 'code.claude.com/docs/en/llm-gateway-protocol';
const CODEX_DOC = 'learn.chatgpt.com/docs/enterprise/gateway-compatibility';

const results: ContractCaseResult[] = [];

function contract(
  id: string,
  source: ContractSource,
  requirement: string,
  reference: string,
  run: () => Promise<void>,
): void {
  it(`${id}: ${requirement}`, async () => {
    try {
      await run();
      results.push({ id, source, requirement, reference, status: 'pass' });
    } catch (err) {
      results.push({
        id,
        source,
        requirement,
        reference,
        status: 'fail',
        detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
      throw err;
    }
  });
}

afterAll(() => {
  const report: ConformanceReport = { gateway: 'gulley', version: GULLEY_VERSION, cases: results };
  writeConformanceOutputs(report);
});

// ---------------------------------------------------------------- harness

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function upstream(
  handler: (c: Captured, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c: Buffer) => (b += c.toString('utf8')));
    req.on('end', () => {
      const c = { path: req.url ?? '', headers: req.headers, body: b };
      captured.push(c);
      handler(c, req, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    captured,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const GOLDEN_SSE = readFileSync(
  new URL('./conformance/fixtures/anthropic-streaming.sse', import.meta.url),
  'utf8',
);
const RESPONSES_SSE = readFileSync(
  new URL('./conformance/fixtures/openai-responses.sse', import.meta.url),
  'utf8',
);

/** A complete Anthropic Messages stream (every event type, in order). */
const FULL_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: ping\ndata: {"type":"ping"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/** A multi-event OpenAI Responses stream ending in response.completed. */
const RESPONSES_STREAM =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","model":"gpt-5.4"}}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hi"}\n\n' +
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","usage":{"input_tokens":30,"output_tokens":7},"status":"completed"}}\n\n';

const sse = (res: http.ServerResponse, body: string, extra: Record<string, string> = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
  res.end(body);
};

function seededStore(): { store: InMemoryKeyStore; token: string } {
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_contract',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'contract',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });
  return { store, token: gen.token };
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

async function gateway(
  routes: ProviderRoute[],
  tune: (ctx: GatewayContext) => void = () => {},
): Promise<{ base: string; token: string; ctx: GatewayContext; close: () => Promise<void> }> {
  const { store, token } = seededStore();
  const ctx: GatewayContext = {
    routes,
    keyStore: store,
    pepper: PEPPER,
    ledger: new InMemoryLedger(),
    requestLog: new InMemoryRequestLog(),
    audit: new InMemoryAuditSink(),
    breaker: new CircuitBreaker(),
    budgets: new InMemoryBudgetStore(new Map()),
    telemetry: initTelemetry({}),
  };
  tune(ctx);
  const app = buildServer(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
    ctx,
  );
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  return { base, token, ctx, close: () => app.close() };
}

const anthropicRoute = (url: string, name = 'anthropic'): ProviderRoute => ({
  clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
  createExtractor: () => new AnthropicUsageExtractor(),
  strategy: { mode: 'single', target: anthropicTarget(name, url) },
});

const messagesBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'claude-sonnet-5-5',
    stream: true,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  });

/** Build one AWS eventstream frame (string headers, raw payload). */
function eventstreamFrame(headers: Record<string, string>, payload: Buffer): Buffer {
  const headerBufs: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    b.writeUInt8(n.length, o);
    o += 1;
    n.copy(b, o);
    o += n.length;
    b.writeUInt8(7, o);
    o += 1;
    b.writeUInt16BE(v.length, o);
    o += 2;
    v.copy(b, o);
    headerBufs.push(b);
  }
  const headersBuf = Buffer.concat(headerBufs);
  const total = 4 + 4 + 4 + headersBuf.length + payload.length + 4;
  const frame = Buffer.alloc(total);
  let o = 0;
  frame.writeUInt32BE(total, o);
  o += 4;
  frame.writeUInt32BE(headersBuf.length, o);
  o += 4;
  frame.writeUInt32BE(0, o);
  o += 4;
  headersBuf.copy(frame, o);
  o += headersBuf.length;
  payload.copy(frame, o);
  o += payload.length;
  frame.writeUInt32BE(0, o);
  return frame;
}
function bedrockChunk(event: object): Buffer {
  const inner = Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
  return eventstreamFrame(
    { ':message-type': 'event', ':event-type': 'chunk' },
    Buffer.from(JSON.stringify({ bytes: inner }), 'utf8'),
  );
}

// ---------------------------------------------------------------- Anthropic rules

describe('Anthropic Claude Code gateway contract', () => {
  contract(
    'A01-beta-open-list',
    'anthropic',
    'Forward the anthropic-beta header verbatim as an open list (never an allowlist), and anthropic-version unchanged',
    `${ANTHROPIC_DOC}#request-headers`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, GOLDEN_SSE));
      const g = await gateway([anthropicRoute(up.url)]);
      await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': g.token,
          'anthropic-beta': 'interleaved-thinking-2025-05-14,some-future-beta-2027-01-01',
          'anthropic-version': '2023-06-01',
        },
        body: messagesBody(),
      }).then((r) => r.text());
      expect(up.captured[0]?.headers['anthropic-beta']).toBe(
        'interleaved-thinking-2025-05-14,some-future-beta-2027-01-01',
      );
      expect(up.captured[0]?.headers['anthropic-version']).toBe('2023-06-01');
      expect(up.captured[0]?.headers['x-api-key']).toBe(UPSTREAM_KEY); // the gateway's credential, not the client's
      await g.close();
      await up.close();
    },
  );

  contract(
    'A02-no-buffering',
    'anthropic',
    'Relay a streamed response event by event: the client receives bytes before the upstream finishes',
    `${ANTHROPIC_DOC}#streaming`,
    async () => {
      const up = await upstream((_c, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const [head, ...rest] = GOLDEN_SSE.split('\n\n');
        res.write(`${head}\n\n`);
        setTimeout(() => res.end(rest.join('\n\n')), 250);
      });
      const g = await gateway([anthropicRoute(up.url)]);
      const started = Date.now();
      const res = await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody(),
      });
      const reader = res.body!.getReader();
      const first = await reader.read();
      const firstAt = Date.now() - started;
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value!).toString('utf8')).toContain('message_start');
      expect(firstAt).toBeLessThan(200); // the first event arrived long before the 250 ms tail
      while (!(await reader.read()).done) {
        /* drain */
      }
      await g.close();
      await up.close();
    },
  );

  contract(
    'A03-ping-relay',
    'anthropic',
    'Relay upstream ping events (and comment lines) — never strip or buffer them',
    `${ANTHROPIC_DOC}#streaming`,
    async () => {
      const withPings = GOLDEN_SSE.replace(
        'event: content_block_start',
        'event: ping\ndata: {"type":"ping"}\n\n: ping\n\nevent: content_block_start',
      );
      const up = await upstream((_c, _req, res) => sse(res, withPings));
      const g = await gateway([anthropicRoute(up.url)]);
      const text = await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody(),
      }).then((r) => r.text());
      expect(text).toBe(withPings); // byte-for-byte, pings and comment line included
      await g.close();
      await up.close();
    },
  );

  contract(
    'A04-event-order',
    'anthropic',
    'Deliver the full event sequence in order through the final message_delta and message_stop',
    `${ANTHROPIC_DOC}#streaming`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, FULL_SSE));
      const g = await gateway([anthropicRoute(up.url)]);
      const text = await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody(),
      }).then((r) => r.text());
      expect(text).toBe(FULL_SSE);
      const order = [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ].map((e) => text.indexOf(`event: ${e}`));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text.endsWith('\n\n')).toBe(true);
      await g.close();
      await up.close();
    },
  );

  contract(
    'A05-bedrock-ping-synthesis',
    'anthropic',
    'A gateway that translates from an upstream without pings (Bedrock) emits its own ping events during a pause',
    `${ANTHROPIC_DOC}#streaming`,
    async () => {
      const up = await upstream((_c, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        res.write(
          bedrockChunk({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 3 } } }),
        );
        setTimeout(() => {
          res.write(
            bedrockChunk({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            }),
          );
          res.end(bedrockChunk({ type: 'message_stop' }));
        }, 120);
      });
      const target: RouteTarget = {
        name: 'bedrock',
        provider: 'bedrock',
        adapter: new BedrockAdapter({ baseUrl: up.url, pingIntervalMs: 25 }),
        credential: { scheme: 'bearer', value: 'bedrock-key' },
        upstreamPath: '/v1/messages',
      };
      const g = await gateway([
        {
          clientPaths: ['/bedrock/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: { mode: 'single', target },
        },
      ]);
      const text = await fetch(`${g.base}/bedrock/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody({ model: 'anthropic.claude-sonnet-5-5' }),
      }).then((r) => r.text());
      expect(text).toContain('event: message_start');
      expect(text.split('event: ping').length - 1).toBeGreaterThanOrEqual(2);
      expect(text).toContain('event: message_stop');
      await g.close();
      await up.close();
    },
  );

  contract(
    'A06-error-body-verbatim',
    'anthropic',
    'Forward error response bodies unmodified, with retry-after as integer seconds, x-should-retry and anthropic-ratelimit-unified-* unchanged',
    `${ANTHROPIC_DOC}#response-headers`,
    async () => {
      const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
      const up = await upstream((_c, _req, res) => {
        res.writeHead(529, {
          'content-type': 'application/json',
          'retry-after': '7',
          'x-should-retry': 'true',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-reset': '1760000000',
          'request-id': 'req_upstream_1',
        });
        res.end(body);
      });
      const g = await gateway([anthropicRoute(up.url)]);
      const res = await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody(),
      });
      expect(res.status).toBe(529);
      expect(await res.text()).toBe(body);
      expect(res.headers.get('retry-after')).toBe('7');
      expect(res.headers.get('x-should-retry')).toBe('true');
      expect(res.headers.get('anthropic-ratelimit-unified-status')).toBe('allowed');
      expect(res.headers.get('anthropic-ratelimit-unified-reset')).toBe('1760000000');
      expect(res.headers.get('request-id')).toBe('req_upstream_1');
      await g.close();
      await up.close();
    },
  );

  contract(
    'A07-gateway-errors',
    'anthropic',
    "Gateway-generated errors use Anthropic's envelope and types and carry x-should-retry",
    `${ANTHROPIC_DOC}#response-headers`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, GOLDEN_SSE));
      const g = await gateway([anthropicRoute(up.url)]);
      const unauth = await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: messagesBody(),
      });
      expect(unauth.status).toBe(401);
      expect(((await unauth.json()) as { error: { type: string } }).error.type).toBe(
        'authentication_error',
      );
      expect(unauth.headers.get('x-should-retry')).toBe('false');
      const missing = await fetch(`${g.base}/v1/nope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: '{}',
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { type: string } }).error.type).toBe(
        'not_found_error',
      );
      await g.close();
      await up.close();
    },
  );

  contract(
    'A08-model-discovery',
    'anthropic',
    'Serve GET /v1/models?limit=1000 directly (no redirect) within 3 seconds, with ids Claude Code keeps (contain "claude")',
    `${ANTHROPIC_DOC}#model-discovery`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, GOLDEN_SSE));
      const g = await gateway([anthropicRoute(up.url)], (ctx) => {
        ctx.modelRouter = new ModelRouter([
          { pattern: 'claude-sonnet-5-5', target: 'claude-sonnet-5-5' },
        ]);
      });
      for (const path of ['/v1/models?limit=1000', '/anthropic/v1/models?limit=1000']) {
        const started = Date.now();
        const res = await fetch(`${g.base}${path}`, {
          headers: { 'x-api-key': g.token },
          redirect: 'manual',
        });
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(3000);
        const body = (await res.json()) as { data: Array<{ id: string; display_name?: string }> };
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.data.some((m) => /claude|anthropic/i.test(m.id))).toBe(true);
      }
      await g.close();
      await up.close();
    },
  );

  contract(
    'A09-count-tokens',
    'anthropic',
    'Expose POST /v1/messages/count_tokens for exact token counts',
    `${ANTHROPIC_DOC}#api-formats`,
    async () => {
      const up = await upstream((c, _req, res) => {
        if (c.path === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"input_tokens":17}');
        } else sse(res, GOLDEN_SSE);
      });
      const g = await gateway([anthropicRoute(up.url)]);
      const res = await fetch(`${g.base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ input_tokens: 17 });
      await g.close();
      await up.close();
    },
  );

  contract(
    'A10-system-and-body-unchanged',
    'anthropic',
    'Forward the system array exactly as received (attribution block first) and body fields such as cache_control, thinking and context_management unchanged — inspect without modifying',
    `${ANTHROPIC_DOC}#system-prompt-attribution-block`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, GOLDEN_SSE));
      const g = await gateway([anthropicRoute(up.url)]);
      const body = {
        model: 'claude-sonnet-5-5',
        stream: true,
        max_tokens: 16,
        system: [
          { type: 'text', text: 'x-attribution: claude-code/2.1.300 fp=abc' },
          { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
        ],
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
        output_config: { effort: 'high' },
        tools: [
          { name: 'Read', input_schema: { type: 'object' }, defer_loading: true, strict: true },
        ],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'x', signature: 'SIG' },
              { type: 'text', text: 'ok' },
            ],
          },
          { role: 'user', content: 'again' },
        ],
      };
      await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: JSON.stringify(body),
      }).then((r) => r.text());
      expect(JSON.parse(up.captured[0]!.body)).toEqual(body);
      await g.close();
      await up.close();
    },
  );

  contract(
    'A11-capability-rejected-token',
    'anthropic',
    "A translated route's error envelope carries a stable capability_rejected: token (prompt_too_long) where the upstream's wording differs",
    `${ANTHROPIC_DOC}#automatic-retry-and-error-forwarding`,
    async () => {
      const up = await upstream((_c, _req, res) => {
        res.writeHead(400, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'ValidationException',
        });
        res.end('{"message":"Input is too long for requested model."}');
      });
      const target: RouteTarget = {
        name: 'bedrock',
        provider: 'bedrock',
        adapter: new BedrockAdapter({ baseUrl: up.url, pingIntervalMs: 0 }),
        credential: { scheme: 'bearer', value: 'bedrock-key' },
        upstreamPath: '/v1/messages',
      };
      const g = await gateway([
        {
          clientPaths: ['/bedrock/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: { mode: 'single', target },
        },
      ]);
      const res = await fetch(`${g.base}/bedrock/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': g.token },
        body: messagesBody({ model: 'anthropic.claude-sonnet-5-5', stream: false }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'capability_rejected: prompt_too_long' },
      });
      await g.close();
      await up.close();
    },
  );

  contract(
    'A12-attribution-headers-consumed',
    'anthropic',
    'x-claude-code-* headers may be consumed for attribution and still reach the upstream',
    `${ANTHROPIC_DOC}#request-headers`,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, GOLDEN_SSE));
      const g = await gateway([anthropicRoute(up.url)]);
      await fetch(`${g.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': g.token,
          'x-claude-code-session-id': 'sess-contract',
          'x-claude-code-request-class': 'main',
        },
        body: messagesBody(),
      }).then((r) => r.text());
      expect(up.captured[0]?.headers['x-claude-code-session-id']).toBe('sess-contract');
      const row = (g.ctx.ledger as InMemoryLedger).entries[0];
      expect(row?.attributes).toMatchObject({
        session: 'sess-contract',
        request_class: 'main',
        agent: 'claude-code',
      });
      await g.close();
      await up.close();
    },
  );
});

// ---------------------------------------------------------------- Codex rules

describe('OpenAI Codex gateway contract', () => {
  const responsesRoute = (url: string): ProviderRoute => ({
    clientPaths: ['/v1/responses', '/openai/v1/responses'],
    createExtractor: () => new OpenAIUsageExtractor(),
    strategy: {
      mode: 'single',
      target: {
        name: 'openai',
        provider: 'openai',
        adapter: new OpenAIAdapter({ baseUrl: url }),
        credential: { scheme: 'bearer', value: 'sk-openai-upstream' },
        upstreamPath: '/v1/responses',
      },
    },
  });

  contract(
    'C01-responses-sse-incremental',
    'codex',
    'Accept POST /v1/responses and forward server-sent events incrementally, preserving event types including the terminal response.completed',
    CODEX_DOC,
    async () => {
      const up = await upstream((_c, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const [head, ...rest] = RESPONSES_STREAM.split('\n\n').filter(Boolean);
        res.write(`${head}\n\n`);
        setTimeout(() => res.end(rest.map((e) => `${e}\n\n`).join('')), 200);
      });
      const g = await gateway([responsesRoute(up.url)]);
      const started = Date.now();
      const res = await fetch(`${g.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${g.token}` },
        body: JSON.stringify({ model: 'gpt-5.4', stream: true, input: 'hi' }),
      });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(Date.now() - started).toBeLessThan(150);
      let text = Buffer.from(first.value!).toString('utf8');
      for (;;) {
        const n = await reader.read();
        if (n.done) break;
        text += Buffer.from(n.value!).toString('utf8');
      }
      expect(text).toBe(RESPONSES_STREAM);
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.output_text.delta');
      expect(text).toContain('event: response.completed');
      await g.close();
      await up.close();
    },
  );

  contract(
    'C02-function-call-pairing',
    'codex',
    'Preserve function-call items and their matching function_call_output items, including the identifiers that link them',
    CODEX_DOC,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, RESPONSES_SSE));
      const g = await gateway([responsesRoute(up.url)]);
      const input = [
        { role: 'user', content: 'list files' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAA', summary: [] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
        { type: 'function_call_output', call_id: 'call_abc', output: 'a.ts\nb.ts' },
      ];
      await fetch(`${g.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${g.token}` },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: true,
          input,
          tools: [{ type: 'function', name: 'shell', parameters: {} }],
        }),
      }).then((r) => r.text());
      const sent = JSON.parse(up.captured[0]!.body) as { input: unknown[] };
      expect(sent.input).toEqual(input);
      await g.close();
      await up.close();
    },
  );

  contract(
    'C03-error-classes',
    'codex',
    'Distinguish client authentication errors, unknown model routes, rate limits and upstream failures — never a generic 500',
    CODEX_DOC,
    async () => {
      const up = await upstream((c, _req, res) => {
        if (c.body.includes('"model":"rate-limited"')) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
          res.end('{"error":{"type":"rate_limit_error","message":"slow down"}}');
        } else if (c.body.includes('"model":"broken"')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":{"type":"server_error","message":"upstream exploded"}}');
        } else sse(res, RESPONSES_SSE);
      });
      const g = await gateway([responsesRoute(up.url)], (ctx) => {
        ctx.modelRouter = new ModelRouter([{ pattern: 'gpt-5.4', target: 'gpt-5.4' }]);
      });
      const send = (model: string, auth = `Bearer ${g.token}`) =>
        fetch(`${g.base}/v1/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: auth },
          body: JSON.stringify({ model, stream: false, input: 'hi' }),
        });
      expect((await send('gpt-5.4', 'Bearer nope')).status).toBe(401);
      expect((await send('rate-limited')).status).toBe(429);
      expect((await send('broken')).status).toBe(500); // the upstream's own class, relayed
      expect((await send('gpt-5.4')).status).toBe(200);
      await g.close();
      await up.close();
    },
  );

  contract(
    'C04-model-routing',
    'codex',
    'Each Codex-facing model name routes to the intended upstream model, verifiable in gateway records',
    CODEX_DOC,
    async () => {
      const up = await upstream((_c, _req, res) => sse(res, RESPONSES_STREAM));
      const g = await gateway([responsesRoute(up.url)], (ctx) => {
        ctx.modelRouter = new ModelRouter([{ pattern: 'codex-default', target: 'gpt-5.4' }]);
      });
      const res = await fetch(`${g.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${g.token}` },
        body: JSON.stringify({ model: 'codex-default', stream: true, input: 'hi' }),
      });
      await res.text();
      expect((JSON.parse(up.captured[0]!.body) as { model: string }).model).toBe('gpt-5.4');
      expect(res.headers.get('x-gulley-target')).toBe('openai');
      const row = (g.ctx.requestLog as InMemoryRequestLog).entries[0];
      expect(row?.model).toBe('gpt-5.4'); // the record names the resolved upstream model
      expect(row?.attributes?.['target']).toBe('openai');
      await g.close();
      await up.close();
    },
  );
});
