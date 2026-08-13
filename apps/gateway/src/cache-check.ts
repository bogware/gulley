/**
 * Live two-tier cache check against real Anthropic + real OpenAI embeddings.
 * Fires four requests through the gateway:
 *   A  — cold           -> expect MISS (goes upstream, then cached)
 *   A' — identical      -> expect HIT-EXACT (byte-identical replay, no upstream)
 *   B  — paraphrase of A -> expect HIT-SEMANTIC (different bytes, near embedding)
 *   C  — unrelated       -> expect MISS
 * Only A and C actually call Anthropic (pennies); the hits are served locally.
 *
 *   pnpm --filter @gulley/gateway run cache:check
 */
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import {
  CacheEngine,
  InMemoryExactCache,
  InMemoryVectorIndex,
  OpenAIEmbeddingProvider,
} from '@gulley/cache';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor, closeUpstreamPool } from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'cache-check-pepper';

function envKey(names: string[], label: string): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new Error(`no ${label} key (looked for ${names.join(', ')})`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const anthropicKey = envKey(['ANTHROPIC_API_KEP', 'ANTHROPIC_API_KEY'], 'Anthropic');
  const openaiKey = envKey(['EMBEDDINGS_API_KEY', 'OPENAI_API_KEY'], 'OpenAI');

  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_live',
    workspaceId: 'ws_live',
    displayName: 'cache',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });

  const cache = new CacheEngine({
    exact: new InMemoryExactCache(),
    semantic: {
      embed: new OpenAIEmbeddingProvider({ apiKey: openaiKey, dimensions: 256 }),
      index: new InMemoryVectorIndex(),
      threshold: 0.9,
    },
    ttlSeconds: 300,
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
            credential: anthropicKey.startsWith('sk-ant-')
              ? { scheme: 'x-api-key', value: anthropicKey }
              : { scheme: 'bearer', value: anthropicKey },
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
    cache,
  };

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const ask = async (content: string): Promise<{ status: number; cache: string; body: string }> => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gen.token },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content }],
      }),
    });
    const body = await res.text();
    return { status: res.status, cache: res.headers.get('x-gulley-cache') ?? '(none)', body };
  };

  try {
    const promptA = 'What is the capital of France? Answer in one word.';
    const promptB = 'what is the capital of france? answer in one word.'; // paraphrase
    const promptC = 'List three prime numbers, comma separated.'; // unrelated

    const a = await ask(promptA);
    await sleep(600); // let the async store settle before the next lookup
    const a2 = await ask(promptA);
    await sleep(300);
    const b = await ask(promptB);
    await sleep(300);
    const c = await ask(promptC);

    process.stdout.write(`A  (cold)       -> ${a.status} cache=${a.cache}\n`);
    process.stdout.write(`A' (identical)  -> ${a2.status} cache=${a2.cache}\n`);
    process.stdout.write(`B  (paraphrase) -> ${b.status} cache=${b.cache}\n`);
    process.stdout.write(`C  (unrelated)  -> ${c.status} cache=${c.cache}\n`);

    const pass =
      a.cache === 'miss' &&
      a2.cache === 'hit-exact' &&
      a2.body === a.body &&
      b.cache === 'hit-semantic' &&
      c.cache === 'miss';
    process.stdout.write(pass ? '✅ CACHE CHECK PASSED\n' : '❌ CACHE CHECK FAILED\n');
    if (!pass) throw new Error('cache tier outcomes did not match expectations');
  } finally {
    await app.close();
    await closeUpstreamPool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
