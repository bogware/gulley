/**
 * Live validation against the REAL Anthropic API. Not a CI test — it needs a
 * real key and network. Runs the actual gateway (in-memory auth/metering/audit
 * + real Anthropic adapter), streams one tiny request through it, and confirms
 * the credential swap, streaming, usage extraction, cost, and audit all work
 * end to end. A 200 with real usage proves the swap: had the gateway forwarded
 * the client's gk_ key, Anthropic would have returned 401.
 *
 *   pnpm --filter @gulley/gateway run live:anthropic
 *
 * Reads the upstream key from the first set of: GULLEY_LIVE_ANTHROPIC_KEY,
 * ANTHROPIC_API_KEP, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN.
 */
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, closeUpstreamPool } from '@gulley/providers';
import { loadConfig } from './config';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const KEY_VARS = [
  'GULLEY_LIVE_ANTHROPIC_KEY',
  'ANTHROPIC_API_KEP',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];
const MODEL = process.env['GULLEY_LIVE_MODEL'] ?? 'claude-haiku-4-5';
const PEPPER = 'live-check-pepper';

function resolveKey(): { name: string; value: string } {
  for (const name of KEY_VARS) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return { name, value: value.trim() };
  }
  throw new Error(`No Anthropic key found. Set one of: ${KEY_VARS.join(', ')}`);
}

async function main(): Promise<void> {
  const key = resolveKey();
  const kind = key.value.startsWith('sk-ant-') ? 'api-key' : 'bearer';
  process.stdout.write(`Using upstream key from $${key.name} (mode: ${kind})\n`);

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
  const ctx: GatewayContext = {
    adapter: new AnthropicAdapter(),
    keyStore: store,
    pepper: PEPPER,
    credential: { kind, value: key.value },
    ledger,
    requestLog,
    audit,
  };

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': gen.token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    });

    const text = await res.text();
    process.stdout.write(`\nHTTP ${res.status} (${res.headers.get('content-type') ?? '?'})\n`);

    if (res.status !== 200) {
      process.stdout.write(`Upstream/gateway error body:\n${text.slice(0, 500)}\n`);
      throw new Error(`expected 200, got ${res.status}`);
    }

    const events = text.split('\n').filter((l) => l.startsWith('event:')).length;
    process.stdout.write(`Streamed ${events} SSE events.\n`);

    const spend = ledger.entries[0];
    if (!spend) throw new Error('no spend recorded — usage was not extracted');
    process.stdout.write(
      [
        '',
        'Metered from real Anthropic usage:',
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
    await closeUpstreamPool(); // drain keep-alive sockets so the loop exits cleanly
  }
}

// Set exitCode rather than calling process.exit(): forcing exit while undici's
// socket is still closing trips a libuv assertion on Windows.
main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
