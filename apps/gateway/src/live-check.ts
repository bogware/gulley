/**
 * Live validation against a REAL provider. Not a CI test — needs a real key and
 * network. Runs the actual gateway (in-memory auth/metering/audit + a real
 * provider adapter) and streams one tiny request through it, confirming the
 * credential swap, streaming, usage extraction, cost, and audit end to end.
 * A 200 with real usage proves the swap: a forwarded gk_ key would 401.
 *
 *   pnpm --filter @gulley/gateway run live:anthropic
 *   pnpm --filter @gulley/gateway run live -- --provider openai
 *   pnpm --filter @gulley/gateway run live -- --provider openai --surface responses
 */
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import {
  AnthropicAdapter,
  AnthropicToOpenAIAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  closeUpstreamPool,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type ProviderAdapter,
  type UpstreamCredential,
  type UsageExtractor,
} from '@gulley/providers';
import { CircuitBreaker, type RouteTarget, type RoutingStrategy } from '@gulley/routing';
import { loadConfig } from './config';
import type { GatewayContext, ProviderRoute } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'live-check-pepper';

function flag(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
}

interface Target {
  provider: string;
  keyVars: string[];
  path: string;
  /** Upstream path if different from the client path (Azure remaps to /openai/v1). */
  upstreamPath?: string;
  adapter: ProviderAdapter;
  extractor: () => UsageExtractor;
  credential: (key: string) => UpstreamCredential;
  clientHeaders: (token: string) => Record<string, string>;
  body: unknown;
  alwaysStream?: boolean;
}

function resolveTarget(): Target {
  const provider = flag('provider', 'anthropic');
  const model = process.env['GULLEY_LIVE_MODEL'];

  if (provider === 'openai') {
    const responses = flag('surface', 'chat') === 'responses';
    return {
      provider: 'openai',
      keyVars: ['GULLEY_LIVE_OPENAI_KEY', 'OPENAI_API_KEY'],
      path: responses ? '/v1/responses' : '/v1/chat/completions',
      adapter: new OpenAIAdapter(),
      extractor: () => new OpenAIUsageExtractor(),
      credential: (k) => ({ scheme: 'bearer', value: k }),
      clientHeaders: (t) => ({ authorization: `Bearer ${t}` }),
      body: responses
        ? {
            model: model ?? 'gpt-4o-mini',
            stream: true,
            input: 'Reply with exactly: OK',
            max_output_tokens: 16,
          }
        : {
            model: model ?? 'gpt-4o-mini',
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          },
    };
  }

  if (provider === 'translate') {
    // Client speaks Anthropic Messages; OpenAI serves it via translation.
    return {
      provider: 'openai',
      keyVars: ['GULLEY_LIVE_OPENAI_KEY', 'OPENAI_API_KEY'],
      path: '/v1/messages',
      upstreamPath: '/v1/chat/completions',
      adapter: new AnthropicToOpenAIAdapter({
        inner: new OpenAIAdapter(),
        targetModel: model ?? 'gpt-4o-mini',
      }),
      extractor: () => new AnthropicUsageExtractor(),
      credential: (k) => ({ scheme: 'bearer', value: k }),
      clientHeaders: (t) => ({ 'x-api-key': t }),
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      },
    };
  }

  if (provider === 'azure') {
    const endpoint = process.env['GULLEY_LIVE_AZURE_ENDPOINT'] ?? process.env['AZURE_ENDPOINT'];
    if (!endpoint)
      throw new Error('Set GULLEY_LIVE_AZURE_ENDPOINT (the Azure resource endpoint URL)');
    const responses = flag('surface', 'chat') === 'responses';
    const deployment = model ?? 'gpt-4o-mini';
    return {
      provider: 'azure',
      keyVars: ['GULLEY_LIVE_AZURE_KEY', 'AZURE_API_KEY', 'AZURE_UPSTREAM_API_KEY'],
      path: responses ? '/azure/v1/responses' : '/azure/v1/chat/completions',
      upstreamPath: responses ? '/openai/v1/responses' : '/openai/v1/chat/completions',
      adapter: new AzureAdapter({ baseUrl: endpoint }),
      extractor: () => new OpenAIUsageExtractor(),
      // A JWT (Entra token) uses bearer; otherwise the resource api-key.
      credential: (k) =>
        k.startsWith('eyJ') ? { scheme: 'bearer', value: k } : { scheme: 'api-key', value: k },
      clientHeaders: (t) => ({ authorization: `Bearer ${t}` }),
      body: responses
        ? {
            model: deployment,
            stream: true,
            input: 'Reply with exactly: OK',
            max_output_tokens: 16,
          }
        : {
            model: deployment,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          },
    };
  }

  if (provider === 'bedrock') {
    const region = process.env['GULLEY_LIVE_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
    return {
      provider: 'bedrock',
      keyVars: ['GULLEY_LIVE_BEDROCK_KEY', 'BEDROCK_API_KEY'],
      path: '/bedrock/v1/messages',
      adapter: new BedrockAdapter({ region }),
      extractor: () => new AnthropicUsageExtractor(),
      credential: (k) => ({ scheme: 'bearer', value: k }),
      clientHeaders: (t) => ({ 'x-api-key': t }),
      alwaysStream: true,
      body: {
        model: model ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      },
    };
  }

  return {
    provider: 'anthropic',
    keyVars: [
      'GULLEY_LIVE_ANTHROPIC_KEY',
      'ANTHROPIC_API_KEP',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ],
    path: '/v1/messages',
    adapter: new AnthropicAdapter(),
    extractor: () => new AnthropicUsageExtractor(),
    credential: (k) =>
      k.startsWith('sk-ant-') ? { scheme: 'x-api-key', value: k } : { scheme: 'bearer', value: k },
    clientHeaders: (t) => ({ 'x-api-key': t }),
    body: {
      model: model ?? 'claude-haiku-4-5',
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    },
  };
}

function resolveKey(vars: string[]): { name: string; value: string } {
  for (const name of vars) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return { name, value: value.trim() };
  }
  throw new Error(`No key found. Set one of: ${vars.join(', ')}`);
}

async function main(): Promise<void> {
  const t = resolveTarget();
  const key = resolveKey(t.keyVars);
  process.stdout.write(`Provider: ${t.provider}  path: ${t.path}  key: $${key.name}\n`);

  const store = new InMemoryKeyStore();
  const gen = generateVirtualKey(PEPPER);
  store.add({
    id: 'vk_live',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_live',
    workspaceId: 'ws_live',
    displayName: 'live-check',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });

  const ledger = new InMemoryLedger();
  const requestLog = new InMemoryRequestLog();
  const audit = new InMemoryAuditSink();
  const target: RouteTarget = {
    name: t.provider,
    provider: t.provider,
    adapter: t.adapter,
    credential: t.credential(key.value),
    upstreamPath: t.upstreamPath ?? t.path,
    alwaysStream: t.alwaysStream,
  };
  // --scenario failover prepends an unreachable target to prove pre-first-byte failover.
  const strategy: RoutingStrategy =
    flag('scenario', '') === 'failover'
      ? {
          mode: 'fallback',
          targets: [
            {
              ...target,
              name: 'unreachable',
              adapter: new OpenAIAdapter({ baseUrl: 'http://127.0.0.1:1' }),
            },
            target,
          ],
        }
      : { mode: 'single', target };
  const route: ProviderRoute = { clientPaths: [t.path], createExtractor: t.extractor, strategy };
  const ctx: GatewayContext = {
    routes: [route],
    keyStore: store,
    pepper: PEPPER,
    ledger,
    requestLog,
    audit,
    breaker: new CircuitBreaker(),
  };

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const res = await fetch(`${base}${t.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...t.clientHeaders(gen.token) },
      body: JSON.stringify(t.body),
    });
    const text = await res.text();
    process.stdout.write(`\nHTTP ${res.status} (${res.headers.get('content-type') ?? '?'})\n`);
    process.stdout.write(`served target: ${res.headers.get('x-gulley-target') ?? '?'}\n`);

    if (res.status !== 200) {
      process.stdout.write(`Error body:\n${text.slice(0, 600)}\n`);
      throw new Error(`expected 200, got ${res.status}`);
    }

    const events = text
      .split('\n')
      .filter((l) => l.startsWith('event:') || l.startsWith('data:')).length;
    process.stdout.write(`Streamed ${events} SSE lines.\n`);

    const spend = ledger.entries[0];
    if (!spend) throw new Error('no spend recorded — usage was not extracted');
    process.stdout.write(
      [
        '',
        'Metered from real provider usage:',
        `  model:          ${spend.model}`,
        `  input tokens:   ${spend.cost.totalInputTokens}`,
        `  output tokens:  ${spend.cost.outputTokens}`,
        `  cost (USD):     $${spend.cost.totalUsd.toFixed(6)} (priced=${spend.cost.priced})`,
        `  request status: ${spend.status}`,
        '',
        `Request log entries: ${requestLog.entries.length}`,
        `Audit rows: ${audit.rows.length}, chain verifies: ${audit.verify()}`,
        '',
      ].join('\n'),
    );

    const ok = spend.cost.outputTokens > 0 && audit.verify() && requestLog.entries.length === 1;
    process.stdout.write(ok ? '✅ LIVE CHECK PASSED\n' : '❌ LIVE CHECK FAILED\n');
    if (!ok) throw new Error('assertions failed');
  } finally {
    await app.close();
    await closeUpstreamPool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
