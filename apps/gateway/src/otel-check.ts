/**
 * Live OpenTelemetry check. Spins a local OTLP/HTTP receiver, runs one real
 * request through the gateway with telemetry pointed at it, force-flushes, and
 * asserts a GenAI-convention span arrived with provider + token attributes.
 *
 *   pnpm --filter @gulley/gateway run otel:check
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor, closeUpstreamPool } from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'otel-check-pepper';

interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}
interface OtlpSpan {
  name: string;
  attributes?: OtlpAttr[];
}

function anthropicKey(): string {
  for (const n of ['GULLEY_LIVE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEP', 'ANTHROPIC_API_KEY']) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new Error('no Anthropic key (set ANTHROPIC_API_KEP)');
}

function attrValue(span: OtlpSpan, key: string): Record<string, unknown> | undefined {
  return span.attributes?.find((a) => a.key === key)?.value;
}

async function main(): Promise<void> {
  const key = anthropicKey();
  const spans: OtlpSpan[] = [];

  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      try {
        const json = JSON.parse(body) as {
          resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
        };
        for (const rs of json.resourceSpans ?? [])
          for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push(sp);
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const otlpBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  process.stdout.write(`OTLP receiver at ${otlpBase}/v1/traces\n`);

  const telemetry = initTelemetry({ endpoint: otlpBase, serviceName: 'gulley-otel-check' });
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_live',
    workspaceId: 'ws_live',
    displayName: 'otel',
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
            adapter: new AnthropicAdapter(),
            credential: key.startsWith('sk-ant-')
              ? { scheme: 'x-api-key', value: key }
              : { scheme: 'bearer', value: key },
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
    telemetry,
  };

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gen.token },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    });
    await res.text();

    await telemetry.forceFlush();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the receiver settle

    const span = spans.find((s) => attrValue(s, 'gen_ai.provider.name'));
    if (!span) throw new Error(`no GenAI span received (${spans.length} spans total)`);

    const provider = attrValue(span, 'gen_ai.provider.name');
    const outTokens = attrValue(span, 'gen_ai.usage.output_tokens');
    const cost = attrValue(span, 'gulley.cost.micro_usd');
    process.stdout.write(`\nReceived span: "${span.name}"\n`);
    process.stdout.write(`  gen_ai.provider.name = ${JSON.stringify(provider)}\n`);
    process.stdout.write(`  gen_ai.usage.output_tokens = ${JSON.stringify(outTokens)}\n`);
    process.stdout.write(`  gulley.cost.micro_usd = ${JSON.stringify(cost)}\n`);

    const providerOk = provider?.['stringValue'] === 'anthropic';
    const outOk = outTokens !== undefined;
    const pass = providerOk && outOk;
    process.stdout.write(pass ? '✅ OTEL CHECK PASSED\n' : '❌ OTEL CHECK FAILED\n');
    if (!pass) throw new Error('span missing expected GenAI attributes');
  } finally {
    await telemetry.shutdown();
    await app.close();
    await closeUpstreamPool();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
