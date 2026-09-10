import type { UsageExtractor } from '@gulley/providers';
import type { SmartRoutingIdentity, SmartRoutingPolicy } from '@gulley/routing';
import { describe, expect, it } from 'vitest';
import type { ProviderRoute } from './routes/messages';
import { InMemoryCentroidIndex } from './smart-classifier-embedding';
import { buildSmartRouter } from './smart-router';

const extractorFor = (name: string) => (): UsageExtractor =>
  ({ tag: name }) as unknown as UsageExtractor;

function route(provider: string, paths: string[]): ProviderRoute {
  return {
    clientPaths: paths,
    createExtractor: extractorFor(provider),
    strategy: {
      mode: 'single',
      target: {
        name: provider,
        provider,
        // The adapter is never invoked by buildSmartRouter/route resolution.
        adapter: {} as never,
        credential: { scheme: 'bearer', value: 'x' },
        upstreamPath: '/p',
      },
    },
  };
}

const ROUTES: ProviderRoute[] = [
  route('anthropic', ['/v1/messages']),
  route('openai', ['/v1/chat/completions']),
];

const IDENTITY: SmartRoutingIdentity = {
  userId: 'u1',
  groups: ['eng'],
  orgId: 'org1',
  workspaceId: 'ws1',
  clientPaths: ['/v1/messages'],
};

function policy(over: Partial<SmartRoutingPolicy>): SmartRoutingPolicy {
  return {
    name: 'p',
    objective: 'cost-tier',
    classifier: { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 20 }] },
    categoryRoutes: { cheap: 'haiku-3-5', hard: 'openai' },
    selector: {},
    ...over,
  };
}

describe('buildSmartRouter', () => {
  it('returns undefined when there are no policies (feature off)', () => {
    expect(buildSmartRouter([], ROUTES)).toBeUndefined();
  });

  it('resolves a model-only reference to a model rewrite on the current route', async () => {
    const sr = buildSmartRouter([policy({})], ROUTES);
    const decision = await sr!.route(IDENTITY, 'short'); // matches maxChars ⇒ cheap
    expect(decision).toEqual({ model: 'haiku-3-5' });
  });

  it('resolves a provider-kind reference to a single-target reroute with that extractor', async () => {
    const sr = buildSmartRouter([policy({})], ROUTES);
    // A long prompt skips the maxChars rule; no model configured ⇒ abstain ⇒
    // defaultCategory 'hard' → the 'openai' reference.
    const decision = await sr!.route(
      { ...IDENTITY },
      'a much longer prompt that exceeds the twenty char cap',
    );
    // Abstains with no default ⇒ undefined; add a default and re-check below.
    expect(decision).toBeUndefined();

    const sr2 = buildSmartRouter([policy({ defaultCategory: 'hard' })], ROUTES);
    const d2 = await sr2!.route(IDENTITY, 'a much longer prompt that exceeds the twenty char cap');
    expect(d2?.strategy).toMatchObject({ mode: 'single', target: { provider: 'openai' } });
    expect((d2?.createExtractor?.() as unknown as { tag: string }).tag).toBe('openai');
    expect(d2?.model).toBeUndefined();
  });

  it('resolves a kind:model reference to a reroute plus a model rewrite', async () => {
    const sr = buildSmartRouter(
      [policy({ categoryRoutes: { cheap: 'anthropic:claude-haiku-4-5' } })],
      ROUTES,
    );
    const decision = await sr!.route(IDENTITY, 'short');
    expect(decision?.strategy).toMatchObject({ mode: 'single', target: { provider: 'anthropic' } });
    expect(decision?.model).toBe('claude-haiku-4-5');
  });

  it('returns undefined when no policy matches the identity', async () => {
    const sr = buildSmartRouter([policy({ selector: { user: 'someone-else' } })], ROUTES);
    expect(await sr!.route(IDENTITY, 'short')).toBeUndefined();
  });

  it('routes via embedding-nearest-label using centroids + an embedder', async () => {
    const centroids = new InMemoryCentroidIndex();
    centroids.add('emb', 'cheap', [1, 0]);
    centroids.add('emb', 'hard', [0, 1]);
    // A "simple" prompt embeds near the 'cheap' centroid; a "hard" one near 'hard'.
    const embed = async (t: string) => (t === 'simple' ? [0.95, 0.05] : [0.05, 0.95]);
    const p = policy({
      name: 'emb',
      classifier: { mode: 'embedding-nearest-label' },
      categoryRoutes: { cheap: 'claude-haiku-4-5', hard: 'openai' },
    });
    const sr = buildSmartRouter([p], ROUTES, {
      embedder: { embed },
      centroids,
      similarityThreshold: 0.5,
    });
    expect(await sr!.route(IDENTITY, 'simple')).toEqual({ model: 'claude-haiku-4-5' });
    expect((await sr!.route(IDENTITY, 'complex'))?.strategy).toMatchObject({
      target: { provider: 'openai' },
    });
  });

  it('abstains (embedding) when the nearest centroid is below the similarity floor', async () => {
    const centroids = new InMemoryCentroidIndex();
    centroids.add('emb', 'cheap', [1, 0]);
    const embed = async () => [0, 1]; // orthogonal ⇒ cosine 0 < floor
    const p = policy({
      name: 'emb',
      classifier: { mode: 'embedding-nearest-label' },
      categoryRoutes: { cheap: 'claude-haiku-4-5' },
    });
    const sr = buildSmartRouter([p], ROUTES, {
      embedder: { embed },
      centroids,
      similarityThreshold: 0.5,
    });
    expect(await sr!.route(IDENTITY, 'x')).toBeUndefined();
  });

  it('fails open (no decision) when a kind:model reference names an unwired provider', async () => {
    // Only anthropic is built; a category pinned to openai:gpt-4o is unroutable
    // and must NOT rewrite the model to the literal "openai:gpt-4o" on anthropic.
    const anthropicOnly = [route('anthropic', ['/v1/messages'])];
    const sr = buildSmartRouter(
      [policy({ categoryRoutes: { cheap: 'openai:gpt-4o' } })],
      anthropicOnly,
    );
    expect(await sr!.route(IDENTITY, 'short')).toBeUndefined();
  });

  it('falls back to defaultCategory when the classifier returns an unrouted category', async () => {
    // A rule yields a category with no route; the declared default must win.
    const p = policy({
      classifier: { mode: 'rules-then-llm', rules: [{ category: 'unknown-label', maxChars: 20 }] },
      categoryRoutes: { cheap: 'haiku-3-5' },
      defaultCategory: 'cheap',
    });
    expect(await buildSmartRouter([p], ROUTES)!.route(IDENTITY, 'short')).toEqual({
      model: 'haiku-3-5',
    });
  });

  it('returns undefined for an unrouted category when no default is configured', async () => {
    const p = policy({
      classifier: { mode: 'rules-then-llm', rules: [{ category: 'unknown-label', maxChars: 20 }] },
      categoryRoutes: { cheap: 'haiku-3-5' },
    });
    expect(await buildSmartRouter([p], ROUTES)!.route(IDENTITY, 'short')).toBeUndefined();
  });

  it('drops a residency-non-compliant llm classifier target so the classifier abstains', async () => {
    // The classifier egresses the prompt to the 'openai' target, which carries no region
    // stamp. Under an active residency allowlist it cannot be proven compliant, so
    // buildSmartRouter drops it: no completer is wired → llm classification abstains →
    // the decision falls to defaultCategory (fail-closed on the residency dimension).
    const p = policy({
      classifier: { mode: 'llm-router', model: 'router-mini', providerRef: 'openai' },
      categoryRoutes: { cheap: 'haiku-3-5', hard: 'openai' },
      defaultCategory: 'cheap',
    });
    const sr = buildSmartRouter(
      [p],
      ROUTES,
      {},
      {
        allowedRegions: new Set(['eu-central-1']),
        requireZdr: false,
      },
    );
    // Abstained (target dropped) → defaultCategory 'cheap' → the model-only rewrite.
    expect(await sr!.route(IDENTITY, 'anything long enough to skip any rule')).toEqual({
      model: 'haiku-3-5',
    });
  });

  it('stamps downgradeOnScopeDenied from the policy onto the decision (default: absent)', async () => {
    const withFlag = buildSmartRouter([policy({ downgradeOnScopeDenied: true })], ROUTES);
    expect(await withFlag!.route(IDENTITY, 'short')).toEqual({
      model: 'haiku-3-5',
      downgradeOnScopeDenied: true,
    });
    const without = buildSmartRouter([policy({})], ROUTES);
    expect(await without!.route(IDENTITY, 'short')).toEqual({ model: 'haiku-3-5' });
  });

  it('does not bleed routes between workspaces that share a policy name', async () => {
    // Two workspaces each define a policy named "cost" (names are only unique
    // within a workspace). Each request must get ITS workspace's categoryRoutes.
    const wsA = policy({
      name: 'cost',
      selector: { workspace: 'wsA' },
      categoryRoutes: { cheap: 'model-a' },
    });
    const wsB = policy({
      name: 'cost',
      selector: { workspace: 'wsB' },
      categoryRoutes: { cheap: 'model-b' },
    });
    const sr = buildSmartRouter([wsA, wsB], ROUTES);
    const a = await sr!.route({ ...IDENTITY, workspaceId: 'wsA' }, 'short');
    const b = await sr!.route({ ...IDENTITY, workspaceId: 'wsB' }, 'short');
    expect(a).toEqual({ model: 'model-a' });
    expect(b).toEqual({ model: 'model-b' });
  });
});
