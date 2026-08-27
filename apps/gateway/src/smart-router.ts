import type { UsageExtractor } from '@gulley/providers';
import {
  allTargets,
  type ClassifierDeps,
  classifyRequest,
  MapSmartRouteResolver,
  type RoutingStrategy,
  type SmartRouteResolver,
  type SmartRoutingIdentity,
  type SmartRoutingPolicy,
} from '@gulley/routing';
import type { ProviderRoute } from './routes/messages';

/**
 * The live routing change a classified category resolves to. Any subset:
 * `strategy` reroutes to a different target (with its own `createExtractor` when
 * that crosses provider family), `model` rewrites the outbound model on the same
 * route. Absent fields leave that dimension unchanged.
 */
export interface SmartRouteDecision {
  strategy?: RoutingStrategy;
  createExtractor?: () => UsageExtractor;
  model?: string;
}

/**
 * Smart routing wrapper (M15). Resolves the policy for a request (selector
 * precedence), classifies the prompt into a category, and maps that category to a
 * pre-resolved live decision. Returns `undefined` on a policy miss, an
 * abstention, or a category with no wired route — so the hot-path caller's
 * fallback (keep the model-router/route strategy) is a plain no-op.
 */
export class SmartRouter {
  constructor(
    private readonly resolver: SmartRouteResolver<string>,
    // Keyed by the policy OBJECT, not its name: policy names are only unique
    // within a workspace, so a global name key would let one workspace's
    // same-named policy shadow another's (cross-tenant route bleed). The resolver
    // returns the correct per-request policy object, so identity keying is safe.
    private readonly decisions: ReadonlyMap<
      SmartRoutingPolicy<string>,
      ReadonlyMap<string, SmartRouteDecision>
    >,
    private readonly deps: ClassifierDeps = {},
  ) {}

  async route(
    identity: SmartRoutingIdentity,
    text: string,
    signal?: AbortSignal,
  ): Promise<SmartRouteDecision | undefined> {
    const policy = this.resolver.resolve(identity);
    if (!policy) return undefined;
    const byCategory = this.decisions.get(policy);
    if (!byCategory) return undefined;
    const category = await classifyRequest(policy, text, this.deps, signal);
    const chosen = category ?? policy.defaultCategory;
    if (chosen === undefined) return undefined;
    return byCategory.get(chosen);
  }
}

/**
 * Resolve one `categoryRoutes` reference against the built routes, or `undefined`
 * (fail open — no decision) when it cannot be honored. Forms:
 *   - `"kind"`         → reroute to that provider's primary target.
 *   - `"kind:model"`   → reroute to that provider AND rewrite the model.
 *   - a bare token     → a model-only rewrite on the current route (same-provider
 *                        tiering, e.g. cheap vs frontier model).
 * A colon reference explicitly names a provider; if that provider has no built
 * route (its upstream key is absent) the category is unroutable → `undefined`
 * (never rewrite the model to a bogus `kind:model` string or send that provider's
 * model to the current, different provider).
 */
function resolveRef(
  ref: string,
  byProvider: ReadonlyMap<string, SmartRouteDecision>,
): SmartRouteDecision | undefined {
  const idx = ref.indexOf(':');
  if (idx >= 0) {
    const provider = byProvider.get(ref.slice(0, idx));
    if (!provider) return undefined; // named provider not wired → fail open
    return { ...provider, model: ref.slice(idx + 1) };
  }
  const provider = byProvider.get(ref);
  return provider ? { ...provider } : { model: ref };
}

/**
 * Build a live `SmartRouter` from validated policies + the current route table.
 * Each provider's FIRST built route is its primary target (chat/messages), which
 * is what a category reroute translates to. Returns `undefined` when there are no
 * policies (feature off).
 */
export function buildSmartRouter(
  policies: readonly SmartRoutingPolicy<string>[],
  routes: readonly ProviderRoute[],
  deps: ClassifierDeps = {},
): SmartRouter | undefined {
  if (policies.length === 0) return undefined;

  const byProvider = new Map<string, SmartRouteDecision>();
  for (const r of routes) {
    for (const t of allTargets(r.strategy)) {
      if (!byProvider.has(t.provider)) {
        byProvider.set(t.provider, {
          strategy: { mode: 'single', target: t },
          createExtractor: r.createExtractor,
        });
      }
    }
  }

  const decisions = new Map<SmartRoutingPolicy<string>, Map<string, SmartRouteDecision>>();
  for (const p of policies) {
    const byCategory = new Map<string, SmartRouteDecision>();
    for (const [category, ref] of Object.entries(p.categoryRoutes)) {
      const decision = resolveRef(ref, byProvider);
      if (decision) byCategory.set(category, decision); // drop unroutable categories
    }
    decisions.set(p, byCategory);
  }

  return new SmartRouter(new MapSmartRouteResolver(policies), decisions, deps);
}
