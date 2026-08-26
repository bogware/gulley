import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type ProviderAdapter,
  type UsageExtractor,
} from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

/**
 * Black-box conformance harness. Each case replays a REAL captured provider wire
 * stream (a fixture file) through the full assembled gateway and asserts the
 * data-plane invariants end-to-end:
 *   1. raw-byte fidelity   — the client receives the upstream bytes verbatim
 *                            (provider-affine artifacts like thinking signatures
 *                            survive), and
 *   2. meter-from-raw-usage — the metered tokens equal the provider's own usage,
 *                            and
 *   3. single teardown      — exactly one ledger + request-log + audit row.
 *
 * Adding a provider quirk = adding a fixture + a row here. Fixtures live in
 * ./conformance/fixtures and are the shared record/replay corpus.
 */

const PEPPER = 'conformance-pepper';
const UPSTREAM_KEY = 'sk-ant-upstream';

interface Case {
  name: string;
  provider: string;
  fixture: string;
  clientPath: string;
  upstreamPath: string;
  adapter: (baseUrl: string) => ProviderAdapter;
  extractor: () => UsageExtractor;
  /** Metered token expectations (from the provider's own usage). */
  expect: { totalInputTokens: number; outputTokens: number };
  /** Substrings that MUST survive verbatim to the client (fidelity markers). */
  clientContains: string[];
}

const CASES: Case[] = [
  {
    name: 'anthropic streaming (input/cache/output usage)',
    provider: 'anthropic',
    fixture: 'anthropic-streaming.sse',
    clientPath: '/v1/messages',
    upstreamPath: '/v1/messages',
    adapter: (b) => new AnthropicAdapter({ baseUrl: b }),
    extractor: () => new AnthropicUsageExtractor(),
    expect: { totalInputTokens: 130, outputTokens: 42 }, // 100 + 20 cache-read + 10 cache-write
    clientContains: ['message_start', '"stop_reason":"end_turn"', 'Hello'],
  },
  {
    name: 'anthropic extended-thinking signature round-trip',
    provider: 'anthropic',
    fixture: 'anthropic-thinking.sse',
    clientPath: '/v1/messages',
    upstreamPath: '/v1/messages',
    adapter: (b) => new AnthropicAdapter({ baseUrl: b }),
    extractor: () => new AnthropicUsageExtractor(),
    expect: { totalInputTokens: 10, outputTokens: 5 },
    clientContains: ['signature_delta', 'EqoBCkgIARABGAIiQfakethinkingsig9876543210'],
  },
  {
    name: 'openai chat completions (prompt includes cached)',
    provider: 'openai',
    fixture: 'openai-chat.sse',
    clientPath: '/v1/chat/completions',
    upstreamPath: '/v1/chat/completions',
    adapter: (b) => new OpenAIAdapter({ baseUrl: b }),
    extractor: () => new OpenAIUsageExtractor(),
    expect: { totalInputTokens: 20, outputTokens: 5 }, // prompt_tokens 20 (incl 8 cached)
    clientContains: ['"content":"OK"', '[DONE]'],
  },
  {
    name: 'openai responses API (response.completed usage)',
    provider: 'openai',
    fixture: 'openai-responses.sse',
    clientPath: '/v1/responses',
    upstreamPath: '/v1/responses',
    adapter: (b) => new OpenAIAdapter({ baseUrl: b }),
    extractor: () => new OpenAIUsageExtractor(),
    expect: { totalInputTokens: 30, outputTokens: 7 }, // input_tokens 30 (incl 10 cached)
    clientContains: ['response.completed', 'gpt-4.1-mini'],
  },
];

function seededStore(): { store: InMemoryKeyStore; token: string } {
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_conf',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'conformance',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });
  return { store, token: gen.token };
}

describe('provider conformance (record/replay)', () => {
  for (const c of CASES) {
    it(`${c.provider}: ${c.name}`, async () => {
      const fixtureBytes = readFileSync(
        new URL(`./conformance/fixtures/${c.fixture}`, import.meta.url),
        'utf8',
      );

      // Fake upstream: replay the captured wire bytes verbatim.
      const upstream = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(fixtureBytes);
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

      const { store, token } = seededStore();
      const ledger = new InMemoryLedger();
      const requestLog = new InMemoryRequestLog();
      const audit = new InMemoryAuditSink();
      const ctx: GatewayContext = {
        routes: [
          {
            clientPaths: [c.clientPath],
            createExtractor: c.extractor,
            strategy: {
              mode: 'single',
              target: {
                name: c.provider,
                provider: c.provider,
                adapter: c.adapter(upstreamUrl),
                credential: { scheme: 'x-api-key', value: UPSTREAM_KEY },
                upstreamPath: c.upstreamPath,
              },
            },
          },
        ],
        keyStore: store,
        pepper: PEPPER,
        ledger,
        requestLog,
        audit,
        breaker: new CircuitBreaker(),
        budgets: new InMemoryBudgetStore(new Map()),
        telemetry: initTelemetry({}),
      };
      const app = buildServer(
        loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
        ctx,
      );
      const base = await app.listen({ port: 0, host: '127.0.0.1' });

      const res = await fetch(`${base}${c.clientPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': token },
        body: JSON.stringify({
          model: 'm',
          stream: true,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const text = await res.text();

      // (1) raw-byte fidelity: the client got the upstream bytes verbatim.
      expect(res.status).toBe(200);
      expect(text).toBe(fixtureBytes);
      for (const s of c.clientContains) expect(text).toContain(s);

      // (3) single teardown: exactly one durable row in each sink.
      expect(ledger.entries).toHaveLength(1);
      expect(requestLog.entries).toHaveLength(1);
      expect(audit.rows).toHaveLength(1);
      expect(audit.verify()).toBe(true);

      // (2) meter-from-raw-usage: metered tokens equal the provider's own usage.
      expect(ledger.entries[0]?.cost.totalInputTokens).toBe(c.expect.totalInputTokens);
      expect(ledger.entries[0]?.cost.outputTokens).toBe(c.expect.outputTokens);

      await app.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    });
  }
});
