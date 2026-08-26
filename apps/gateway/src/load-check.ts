/**
 * Load smoke check (manual — like the live-checks, NOT part of CI).
 *
 * Drives concurrent traffic through a full in-process gateway backed by a FAKE,
 * fast upstream (no real provider cost), then asserts the same SLOs the M13
 * dashboards visualize (ops/prometheus/gulley-slo-alerts.yml):
 *   • availability  — error ratio < 0.005 (99.5%); only 5xx/transport count
 *   • latency       — p99 end-to-end < 10s
 *
 * This measures the PIPELINE overhead (auth → authz → guardrail → cache lookup →
 * budget → forward → raw pipe → teardown), not a provider. For load against a
 * DEPLOYED gateway, use ops/load/gateway-load.js (k6).
 *
 * Usage:  pnpm --filter @gulley/gateway load:check
 *   env:  LOAD_CONCURRENCY (50)  LOAD_DURATION_MS (5000)
 *         LOAD_P99_MS (10000)    LOAD_MAX_ERROR_RATIO (0.005)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor } from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'load-pepper';
const GOLDEN_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":1}}}',
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<void> {
  const concurrency = Number(process.env['LOAD_CONCURRENCY'] ?? 50);
  const durationMs = Number(process.env['LOAD_DURATION_MS'] ?? 5000);
  const p99Budget = Number(process.env['LOAD_P99_MS'] ?? 10_000);
  const maxErrorRatio = Number(process.env['LOAD_MAX_ERROR_RATIO'] ?? 0.005);

  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(GOLDEN_SSE);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_load',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    displayName: 'load',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });

  const ctx: GatewayContext = {
    routes: [
      {
        clientPaths: ['/v1/messages'],
        createExtractor: () => new AnthropicUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: 'anthropic',
            provider: 'anthropic',
            adapter: new AnthropicAdapter({ baseUrl: upstreamUrl }),
            credential: { scheme: 'x-api-key', value: 'sk-ant-load' },
            upstreamPath: '/v1/messages',
          },
        },
      },
    ],
    keyStore: store,
    pepper: PEPPER,
    ledger: new InMemoryLedger(),
    requestLog: new InMemoryRequestLog(),
    audit: new InMemoryAuditSink(),
    breaker: new CircuitBreaker(),
    budgets: new InMemoryBudgetStore(new Map()),
    telemetry: initTelemetry({}),
  };
  const app = buildServer(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
    ctx,
  );
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    stream: true,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const headers = { 'content-type': 'application/json', 'x-api-key': gen.token };

  const latencies: number[] = [];
  let errors = 0;
  let total = 0;
  const deadline = Date.now() + durationMs;

  console.log(
    `load: concurrency=${concurrency} duration=${durationMs}ms  SLO p99<${p99Budget}ms errRatio<${maxErrorRatio}`,
  );

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body });
        await res.text();
        if (res.status >= 500) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(Date.now() - t0);
      total += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  latencies.sort((a, b) => a - b);
  const errorRatio = total === 0 ? 1 : errors / total;
  const rps = Math.round((total / durationMs) * 1000);
  const report = {
    requests: total,
    rps,
    errors,
    errorRatio: Number(errorRatio.toFixed(5)),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
  };
  console.log('load: report', JSON.stringify(report, null, 2));

  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));

  const breaches: string[] = [];
  if (report.p99 >= p99Budget) breaches.push(`p99 ${report.p99}ms >= ${p99Budget}ms`);
  if (errorRatio >= maxErrorRatio)
    breaches.push(`error ratio ${report.errorRatio} >= ${maxErrorRatio}`);
  if (breaches.length > 0) {
    console.error('load: SLO BREACH —', breaches.join('; '));
    process.exit(1);
  }
  console.log('load: SLOs met ✓');
}

main().catch((err) => {
  console.error('load-check failed', err);
  process.exit(1);
});
