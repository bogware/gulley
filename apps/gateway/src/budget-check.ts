/**
 * Live budget-enforcement check. Sets a tiny per-workspace cap that fits ONE
 * Haiku call's worst-case reservation but not two, fires two concurrent real
 * requests, and asserts exactly one succeeds (200) and one is rejected (402) —
 * proving the reserve/commit hard cap is TOCTOU-safe under concurrency.
 *
 *   pnpm --filter @gulley/gateway run budget:check
 */
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor, closeUpstreamPool } from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'budget-check-pepper';
const CAP_MICRO_USD = 150; // one Haiku (max_tokens 16) reserves ~120; two would breach

function anthropicKey(): string {
  for (const n of ['GULLEY_LIVE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEP', 'ANTHROPIC_API_KEY']) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new Error('no Anthropic key (set ANTHROPIC_API_KEP)');
}

async function main(): Promise<void> {
  const key = anthropicKey();
  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_live',
    workspaceId: 'ws_live',
    displayName: 'budget',
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
    budgets: new InMemoryBudgetStore(new Map([['ws_live', { capMicroUsd: CAP_MICRO_USD }]])),
    telemetry: initTelemetry({}),
  };

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const once = async (): Promise<number> => {
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
    return res.status;
  };

  try {
    const statuses = await Promise.all([once(), once()]);
    const ok = statuses.filter((s) => s === 200).length;
    const rejected = statuses.filter((s) => s === 402).length;
    process.stdout.write(`cap=${CAP_MICRO_USD}µ$  statuses=${JSON.stringify(statuses.sort())}\n`);
    process.stdout.write(`allowed=${ok}  rejected(402)=${rejected}\n`);
    const pass = ok === 1 && rejected === 1;
    process.stdout.write(pass ? '✅ BUDGET CHECK PASSED\n' : '❌ BUDGET CHECK FAILED\n');
    if (!pass) throw new Error('expected exactly one 200 and one 402');
  } finally {
    await app.close();
    await closeUpstreamPool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
