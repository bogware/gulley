import type { ConfigDocument, ConfigStore, ConfigVersionStore } from '@gulley/config';
import { InMemoryConfigVersionStore } from '@gulley/config';
import { MapSecretResolver } from '@gulley/core';
import { CircuitBreaker, LoadScoreboard } from '@gulley/routing';
import { type ConfigSignal, InMemoryConfigBus } from '@gulley/storage';
import { describe, expect, it, vi } from 'vitest';
import { ConfigWatcher, GatewayReconciler } from './reconcile';
import { type GatewayContext, RouteHolder } from './routes/messages';

const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic';

const docWith = (kind: string): ConfigDocument => ({
  apiVersion: 'gulley/v1',
  orgs: [
    {
      name: 'Acme',
      workspaces: [
        {
          name: 'prod',
          providers: [
            {
              kind,
              baseUrl: null,
              enabled: true,
              credential: { secretArn: ARN, secretVersion: 'v1' } as never,
            },
          ],
          routes: [],
          policies: [],
          budgets: [],
          rateLimits: [],
          guardrails: [],
          modelAliases: [],
          virtualKeys: [],
        },
      ],
    },
  ],
});

const storeReturning = (doc: ConfigDocument): ConfigStore => ({
  exportDocument: async () => doc,
  authorize: async () => true,
  reconcile: async () => ({ summary: { added: [], removed: [], changed: [] } }),
});

function holderWithState(): {
  holder: RouteHolder;
  breaker: CircuitBreaker;
  scoreboard: LoadScoreboard;
} {
  const breaker = new CircuitBreaker();
  const scoreboard = new LoadScoreboard();
  const ctx = { routes: [], breaker, scoreboard } as unknown as GatewayContext;
  return { holder: new RouteHolder(ctx), breaker, scoreboard };
}

describe('GatewayReconciler', () => {
  it('swaps the route table from the document, preserving live state by reference', async () => {
    const { holder, breaker, scoreboard } = holderWithState();
    breaker.recordFailure('anthropic'); // some live state to preserve
    const reconciler = new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      new MapSecretResolver(new Map([[ARN, 'sk-ant-x']])),
    );
    expect(holder.routeFor('/v1/messages')).toBeUndefined(); // empty to start
    await reconciler.reconcile();
    expect(holder.routeFor('/v1/messages')?.strategy).toMatchObject({
      target: { provider: 'anthropic' },
    });
    // The SAME breaker/scoreboard instances survive the swap (state preserved).
    expect(holder.ctx.breaker).toBe(breaker);
    expect(holder.ctx.scoreboard).toBe(scoreboard);
    expect(breaker.errorRate('anthropic')).toBeGreaterThan(0);
  });

  it('reports success/failure so the watcher advances the cursor only on success', async () => {
    const { holder } = holderWithState();
    const ok = new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      new MapSecretResolver(new Map([[ARN, 'k']])),
    );
    expect(await ok.reconcile()).toBe(true);
    const bad = new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      new MapSecretResolver(new Map()), // resolve throws
    );
    expect(await bad.reconcile()).toBe(false);
  });

  it('KEEPS the current config when a secret cannot be resolved (fail-safe)', async () => {
    const { holder } = holderWithState();
    // Seed a working config first.
    await new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      new MapSecretResolver(new Map([[ARN, 'sk-ant-x']])),
    ).reconcile();
    expect(holder.routeFor('/v1/messages')).toBeDefined();

    // A reconcile whose resolver can't resolve the ARN must NOT wipe the routes.
    await new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      new MapSecretResolver(new Map()), // empty → resolve throws
    ).reconcile();
    expect(holder.routeFor('/v1/messages')).toBeDefined(); // old routes intact
  });
});

describe('GatewayReconciler smart routing', () => {
  const validPolicy = {
    name: 'p',
    config: {
      objective: 'cost-tier',
      classifier: { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 20 }] },
      categoryRoutes: { cheap: 'claude-haiku-4-5' },
      selector: {},
    },
  };
  const identity = {
    userId: 'u',
    groups: [],
    orgId: 'o',
    workspaceId: 'w',
    clientPaths: ['/v1/messages'],
  };
  const docWithPolicies = (policies: unknown[]): ConfigDocument => {
    const d = docWith('anthropic');
    (d.orgs[0]!.workspaces[0]! as { smartRoutingPolicies?: unknown }).smartRoutingPolicies =
      policies;
    return d;
  };
  const resolver = () => new MapSecretResolver(new Map([[ARN, 'sk-ant-x']]));

  it('builds + swaps the smart router when enabled with valid policies', async () => {
    const { holder } = holderWithState();
    await new GatewayReconciler(
      holder,
      storeReturning(docWithPolicies([validPolicy])),
      resolver(),
      undefined,
      {
        enabled: true,
      },
    ).reconcile();
    expect(holder.ctx.smartRouter).toBeDefined();
    expect(await holder.ctx.smartRouter!.route(identity, 'hi')).toEqual({
      model: 'claude-haiku-4-5',
    });
  });

  it('KEEPS the old routes AND smart router when a policy is malformed (no partial swap)', async () => {
    const { holder } = holderWithState();
    await new GatewayReconciler(
      holder,
      storeReturning(docWithPolicies([validPolicy])),
      resolver(),
      undefined,
      {
        enabled: true,
      },
    ).reconcile();
    const goodRouter = holder.ctx.smartRouter;
    expect(goodRouter).toBeDefined();

    // A malformed policy (no classifier/categoryRoutes) throws in parse → reconcile
    // fails and must keep BOTH the old routes and the old smart router intact.
    const bad = new GatewayReconciler(
      holder,
      storeReturning(docWithPolicies([{ name: 'bad', config: { objective: 'cost-tier' } }])),
      resolver(),
      undefined,
      { enabled: true },
    );
    expect(await bad.reconcile()).toBe(false);
    expect(holder.routeFor('/v1/messages')).toBeDefined();
    expect(holder.ctx.smartRouter).toBe(goodRouter);
  });

  it('never builds a smart router when disabled, even with policies present', async () => {
    const { holder } = holderWithState();
    await new GatewayReconciler(
      holder,
      storeReturning(docWithPolicies([validPolicy])),
      resolver(),
      undefined,
      {
        enabled: false,
      },
    ).reconcile();
    expect(holder.ctx.smartRouter).toBeUndefined();
  });

  it('swaps to no smart router when enabled but the document has zero policies', async () => {
    const { holder } = holderWithState();
    await new GatewayReconciler(
      holder,
      storeReturning(docWith('anthropic')),
      resolver(),
      undefined,
      {
        enabled: true,
      },
    ).reconcile();
    expect(holder.ctx.smartRouter).toBeUndefined();
  });

  it('builds embedding centroids from a policy exemplar when an embedder is wired', async () => {
    const { holder } = holderWithState();
    const embed = vi.fn(async () => [1, 0]); // exemplar + prompt embed identically
    const embPolicy = {
      name: 'e',
      config: {
        objective: 'domain-skill',
        classifier: { mode: 'embedding-nearest-label', exemplars: { code: ['write a function'] } },
        categoryRoutes: { code: 'claude-haiku-4-5' },
        selector: {},
      },
    };
    await new GatewayReconciler(
      holder,
      storeReturning(docWithPolicies([embPolicy])),
      resolver(),
      undefined,
      { enabled: true, embedder: { embed }, similarityThreshold: 0.5 },
    ).reconcile();
    expect(holder.ctx.smartRouter).toBeDefined();
    // The exemplar was embedded at reconcile; the prompt then classifies to 'code'.
    expect(await holder.ctx.smartRouter!.route(identity, 'anything')).toEqual({
      model: 'claude-haiku-4-5',
    });
    expect(embed).toHaveBeenCalled();
  });
});

describe('ConfigWatcher', () => {
  it('reconciles on a foreign signal and ignores its own', async () => {
    const { holder } = holderWithState();
    const store = storeReturning(docWith('anthropic'));
    const reconciler = new GatewayReconciler(
      holder,
      store,
      new MapSecretResolver(new Map([[ARN, 'k']])),
    );
    const bus = new InMemoryConfigBus();
    const versions = new InMemoryConfigVersionStore();
    const watcher = new ConfigWatcher(bus, reconciler, versions, 'me');
    await watcher.start(); // initial reconcile
    expect(holder.routeFor('/v1/messages')).toBeDefined();

    // Swap the store to openai; a foreign signal should drive a re-reconcile.
    (store as unknown as { exportDocument: () => Promise<ConfigDocument> }).exportDocument =
      async () => docWith('openai');
    const sig: ConfigSignal = { v: 5, hash: 'h', origin: 'peer', ts: 0 };
    await bus.emit(sig);
    await vi.waitFor(() => expect(holder.routeFor('/v1/chat/completions')).toBeDefined());

    // A self-origin signal is dropped (no reconcile) — swap store, emit self, no change.
    (store as unknown as { exportDocument: () => Promise<ConfigDocument> }).exportDocument =
      async () => docWith('anthropic');
    await bus.emit({ v: 6, hash: 'h', origin: 'me', ts: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(holder.routeFor('/v1/chat/completions')).toBeDefined(); // still openai (self ignored)

    await watcher.stop();
  });

  it('converges via the steady-state poll when no signal is emitted', async () => {
    const { holder } = holderWithState();
    const store = storeReturning(docWith('anthropic'));
    const reconciler = new GatewayReconciler(
      holder,
      store,
      new MapSecretResolver(new Map([[ARN, 'k']])),
    );
    const bus = new InMemoryConfigBus();
    // A version store the test advances by hand; the watcher only reads it.
    let version = 1;
    const versions = { currentVersion: async () => version } as unknown as ConfigVersionStore;
    const watcher = new ConfigWatcher(bus, reconciler, versions, 'me', undefined, 5_000, 10);
    await watcher.start(); // initial reconcile at v1
    expect(holder.routeFor('/v1/messages')).toBeDefined();

    // Swap the document and bump the version WITHOUT emitting a signal — only the
    // poll can drive convergence here (the NOTIFY path is silent).
    (store as unknown as { exportDocument: () => Promise<ConfigDocument> }).exportDocument =
      async () => docWith('openai');
    version = 2;
    await vi.waitFor(() => expect(holder.routeFor('/v1/chat/completions')).toBeDefined());

    await watcher.stop();
  });
});
