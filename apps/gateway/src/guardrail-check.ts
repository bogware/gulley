/**
 * Live guardrail check against real Anthropic. Three routes share one upstream
 * but differ by policy:
 *   /audit  — audit-only: request with PII is forwarded UNCHANGED (model sees the
 *             '@', answers YES) and the finding is recorded.
 *   /block  — request containing PII is rejected 403 before any upstream call.
 *   /mask   — PII is reversibly tokenized before upstream (model sees the token,
 *             so it answers NO to "contains '@'?"), and detokenized on the way
 *             back (a repeat-verbatim prompt returns the ORIGINAL value to the
 *             client, with no token leaked).
 *
 *   pnpm --filter @gulley/gateway run guardrail:check
 */
import { generateVirtualKey, InMemoryKeyStore } from '@gulley/auth';
import { InMemoryBudgetStore } from '@gulley/budget';
import { GuardrailEngine, NativeDetector } from '@gulley/guardrails';
import { InMemoryAuditSink, InMemoryLedger, InMemoryRequestLog } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor, closeUpstreamPool } from '@gulley/providers';
import { CircuitBreaker } from '@gulley/routing';
import { initTelemetry } from '@gulley/telemetry';
import { loadConfig } from './config';
import type { GatewayContext, ProviderRoute } from './routes/messages';
import { buildServer } from './server';

const PEPPER = 'guardrail-check-pepper';
const EMAIL = 'jane.doe@example.com';

function anthropicKey(): string {
  for (const n of ['ANTHROPIC_API_KEP', 'ANTHROPIC_API_KEY']) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new Error('no Anthropic key (set ANTHROPIC_API_KEP)');
}

function route(path: string, engine: GuardrailEngine, key: string): ProviderRoute {
  return {
    clientPaths: [path],
    createExtractor: () => new AnthropicUsageExtractor(),
    guardrails: engine,
    cacheable: false,
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
  };
}

function anthropicText(body: string): string {
  try {
    const json = JSON.parse(body) as { content?: Array<{ text?: string }> };
    return (json.content ?? []).map((b) => b.text ?? '').join('');
  } catch {
    return body;
  }
}

async function main(): Promise<void> {
  const key = anthropicKey();
  const detectors = [new NativeDetector()];
  const audit = new InMemoryAuditSink();

  const ctx: GatewayContext = {
    routes: [
      route(
        '/audit/v1/messages',
        new GuardrailEngine(detectors, {
          input: { action: 'audit' },
          output: { action: 'audit' },
        }),
        key,
      ),
      route(
        '/block/v1/messages',
        new GuardrailEngine(detectors, {
          input: { action: 'block', minConfidence: 0.5 },
          output: { action: 'audit' },
        }),
        key,
      ),
      route(
        '/mask/v1/messages',
        new GuardrailEngine(detectors, {
          input: { action: 'mask' },
          output: { action: 'audit' },
        }),
        key,
      ),
    ],
    keyStore: new InMemoryKeyStore(),
    pepper: PEPPER,
    ledger: new InMemoryLedger(),
    requestLog: new InMemoryRequestLog(),
    audit,
    breaker: new CircuitBreaker(),
    budgets: new InMemoryBudgetStore(new Map()),
    telemetry: initTelemetry({}),
  };

  const gen = generateVirtualKey(PEPPER);
  (ctx.keyStore as InMemoryKeyStore).add({
    id: 'vk',
    keyPrefix: gen.keyPrefix,
    keyHash: gen.keyHash,
    orgId: 'org_live',
    workspaceId: 'ws_live',
    displayName: 'guardrail',
    epoch: 0,
    disabled: false,
    expiresAt: null,
    allowedProviders: '*',
    allowedModels: '*',
  });

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const post = async (
    path: string,
    content: string,
  ): Promise<{ status: number; guardrail: string; text: string; body: string }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gen.token },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content }],
      }),
    });
    const body = await res.text();
    return {
      status: res.status,
      guardrail: res.headers.get('x-gulley-guardrail') ?? '(none)',
      text: anthropicText(body),
      body,
    };
  };

  const containsAt = `Answer with only one word, YES or NO: does the following text contain an @ symbol? Text: ${EMAIL}`;
  const repeat = `Output only the exact text between the brackets and nothing else: [${EMAIL}]`;

  try {
    const auditRes = await post('/audit/v1/messages', containsAt);
    const blockRes = await post('/block/v1/messages', containsAt);
    const maskRes = await post('/mask/v1/messages', containsAt);
    const detokRes = await post('/mask/v1/messages', repeat);

    process.stdout.write(`audit  -> ${auditRes.status} model="${auditRes.text.trim()}"\n`);
    process.stdout.write(`block  -> ${blockRes.status} (${firstErrorType(blockRes.body)})\n`);
    process.stdout.write(`mask   -> ${maskRes.status} model="${maskRes.text.trim()}"\n`);
    process.stdout.write(`detok  -> ${detokRes.status} client="${detokRes.text.trim()}"\n`);

    const inputFindings = audit.rows.some(
      (r) => r.action === 'proxy.request' && Number(r.payload?.['guardrailInputFindings']) >= 1,
    );
    const blockedRow = audit.rows.some((r) => r.action === 'guardrail.blocked');

    const auditSawAt = /yes/i.test(auditRes.text); // model saw the '@' (passthrough)
    const blocked =
      blockRes.status === 403 && firstErrorType(blockRes.body) === 'guardrail_blocked';
    const maskHidAt = /\bno\b/i.test(maskRes.text); // model saw the token (no '@')
    const detokRestored = detokRes.text.includes(EMAIL) && !detokRes.text.includes('<<GULLEY_');

    process.stdout.write(
      `\nfindings-recorded=${inputFindings} blocked-audit=${blockedRow} ` +
        `audit-saw-@=${auditSawAt} mask-hid-@=${maskHidAt} detok-restored=${detokRestored}\n`,
    );

    const pass = inputFindings && blockedRow && auditSawAt && blocked && maskHidAt && detokRestored;
    process.stdout.write(pass ? '✅ GUARDRAIL CHECK PASSED\n' : '❌ GUARDRAIL CHECK FAILED\n');
    if (!pass) throw new Error('one or more guardrail behaviors did not hold');
  } finally {
    await app.close();
    await closeUpstreamPool();
  }
}

function firstErrorType(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { type?: string } };
    return json.error?.type ?? '(none)';
  } catch {
    return '(unparseable)';
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
