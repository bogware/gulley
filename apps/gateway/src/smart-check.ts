/**
 * Manual smoke for M15 smart routing (`pnpm --filter @gulley/gateway smart:check`).
 * Deterministic and no-cost: it builds a smart router over stub routes with a
 * cost-tier `rules-then-llm` policy (a stubbed, metered `llm-router` escalation),
 * runs sample prompts through it, and prints the classified category, the routing
 * decision, and — when the classifier escalates — the metered `proxy.classify`
 * line. Exits non-zero if the wiring does not behave as expected.
 */
import { InMemoryBudgetStore } from '@gulley/budget';
import { InMemoryAuditSink, InMemoryLedger } from '@gulley/pipeline';
import { AnthropicAdapter, AnthropicUsageExtractor } from '@gulley/providers';
import type {
  ClassifierCompleter,
  SmartRoutingIdentity,
  SmartRoutingPolicy,
} from '@gulley/routing';
import type { ProviderRoute } from './routes/messages';
import { meterClassifierSpend } from './smart-classifier-meter';
import { buildSmartRouter } from './smart-router';

function route(provider: string, path: string): ProviderRoute {
  return {
    clientPaths: [path],
    createExtractor: () => new AnthropicUsageExtractor(),
    strategy: {
      mode: 'single',
      target: {
        name: provider,
        provider,
        adapter: new AnthropicAdapter({ baseUrl: 'https://example.invalid' }),
        credential: { scheme: 'bearer', value: 'unused' },
        upstreamPath: path,
      },
    },
  };
}

async function main(): Promise<void> {
  const routes: ProviderRoute[] = [
    route('anthropic', '/v1/messages'),
    route('openai', '/v1/chat/completions'),
  ];

  // Stub the llm-router escalation so the smoke is deterministic + free.
  const completer: ClassifierCompleter = {
    complete: async () => ({
      text: 'hard',
      usage: { provider: 'anthropic', model: 'router-x', inputTokens: 15, outputTokens: 1 },
    }),
  };

  const policy: SmartRoutingPolicy = {
    name: 'cost-tier-demo',
    objective: 'cost-tier',
    classifier: {
      mode: 'rules-then-llm',
      rules: [{ category: 'cheap', maxChars: 30 }],
      model: 'router-x',
      providerRef: 'anthropic',
      meterClassifier: true,
    },
    categoryRoutes: { cheap: 'claude-haiku-4-5', hard: 'openai:gpt-4o' },
    defaultCategory: 'hard',
    selector: {},
  };

  const router = buildSmartRouter([policy], routes, { completer });
  if (!router) throw new Error('buildSmartRouter returned undefined');

  const budgets = new InMemoryBudgetStore(new Map([['ws_1', { capMicroUsd: 10_000_000 }]]));
  const ledger = new InMemoryLedger();
  const audit = new InMemoryAuditSink();
  const identity: SmartRoutingIdentity = {
    userId: 'vk_1',
    groups: [],
    orgId: 'org_1',
    workspaceId: 'ws_1',
    clientPaths: ['/v1/messages'],
  };

  const prompts = [
    { label: 'short prompt (rules → cheap)', text: 'hi there' },
    {
      label: 'long prompt (rules miss → llm escalation → hard)',
      text: 'Please design a fault-tolerant multi-region deployment strategy for a stateful service.',
    },
  ];

  let metered = 0;
  for (const p of prompts) {
    const decision = await router.route(identity, p.text, {
      onSpend: (u) => {
        metered++;
        void meterClassifierSpend(
          { budgets, ledger, audit },
          { id: identity.userId, orgId: identity.orgId, workspaceId: identity.workspaceId },
          `req_${metered}`,
          u,
        );
      },
    });
    const target =
      decision?.strategy?.mode === 'single' ? decision.strategy.target.provider : '(same route)';
    console.log(`- ${p.label}\n    → provider=${target} model=${decision?.model ?? '(unchanged)'}`);
  }

  // Let the fire-and-forget meters flush.
  await new Promise((r) => setTimeout(r, 10));

  console.log(
    `\nmetered classifier sub-calls: ${ledger.entries.filter((e) => e.requestId.endsWith('#classify')).length}` +
      ` (audit '${audit.rows.map((r) => r.action).join(', ')}')`,
  );

  const cheap = await router.route(identity, 'hi', {});
  if (cheap?.model !== 'claude-haiku-4-5')
    throw new Error('cost-tier rule did not route short prompt to the cheap model');
  const classifyLines = ledger.entries.filter((e) => e.requestId.endsWith('#classify'));
  if (classifyLines.length !== 1)
    throw new Error(`expected exactly one metered classifier line, got ${classifyLines.length}`);
  if (!audit.rows.some((r) => r.action === 'proxy.classify'))
    throw new Error('missing proxy.classify audit line');

  console.log('\nsmart:check OK');
}

main().catch((err) => {
  console.error('smart:check FAILED:', err);
  process.exit(1);
});
