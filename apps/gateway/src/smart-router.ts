import type { UsageExtractor } from '@gulley/providers';
import {
  allTargets,
  type ClassifierDeps,
  classifyRequest,
  type ClassifierSpendSink,
  MapSmartRouteResolver,
  residencyCompliant,
  type RouteTarget,
  type RoutingStrategy,
  type SmartRouteResolver,
  type SmartRoutingIdentity,
  type SmartRoutingPolicy,
} from '@gulley/routing';
import type { ProviderRoute } from './routes/messages';
import {
  type ClassifierTargetEntry,
  GatewayClassifierCompleter,
} from './smart-classifier-completer';

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
  /** Copied from the resolved policy: when true, an out-of-scope rerouted model is
   *  downgraded to the original (availability) rather than 403'd. See the policy field. */
  downgradeOnScopeDenied?: boolean;
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
    opts?: { signal?: AbortSignal; onSpend?: ClassifierSpendSink },
  ): Promise<SmartRouteDecision | undefined> {
    const policy = this.resolver.resolve(identity);
    if (!policy) return undefined;
    const byCategory = this.decisions.get(policy);
    if (!byCategory) return undefined;
    // Surface the classifier sub-call's spend for metering ONLY when the policy
    // opts into it; otherwise the sink is never invoked.
    const onSpend = policy.classifier.meterClassifier ? opts?.onSpend : undefined;
    const category = await classifyRequest(policy, text, this.deps, opts?.signal, onSpend);
    // Fall back to defaultCategory when the classifier abstains OR returns a
    // category that has no wired route (an out-of-taxonomy label, or a category
    // whose reference was unroutable and dropped from `byCategory`) — honoring the
    // policy's declared default rather than silently no-op'ing.
    const chosen =
      category !== undefined && byCategory.has(category) ? category : policy.defaultCategory;
    if (chosen === undefined) return undefined;
    const decision = byCategory.get(chosen);
    if (!decision) return undefined;
    // Carry the policy's downgrade opt-in onto the decision so the hot-path caller can
    // decide (deny by default) how to handle a rerouted-but-out-of-scope model.
    return policy.downgradeOnScopeDenied ? { ...decision, downgradeOnScopeDenied: true } : decision;
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

/** Data-residency constraint for the classifier sub-call. When present, a classifier
 *  target that cannot be PROVEN compliant is dropped so the classifier abstains rather
 *  than egressing prompt content to a possibly out-of-region / non-ZDR provider. */
export interface ClassifierResidency {
  allowedRegions?: ReadonlySet<string>;
  requireZdr: boolean;
}

/**
 * Build a live `SmartRouter` from validated policies + the current route table.
 * Each provider's FIRST built route is its primary target (chat/messages), which
 * is what a category reroute translates to. Returns `undefined` when there are no
 * policies (feature off). Under an active `residency` constraint, an llm-router
 * classifier target that cannot be proven compliant is dropped (fail-closed egress).
 */
export function buildSmartRouter(
  policies: readonly SmartRoutingPolicy<string>[],
  routes: readonly ProviderRoute[],
  deps: ClassifierDeps = {},
  residency?: ClassifierResidency,
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
  // Resolve the classifier target for each llm-router / rules-then-llm policy that
  // names a model + provider, so the built-in completer can forward to it.
  const byModel = new Map<string, ClassifierTargetEntry>();
  for (const p of policies) {
    const byCategory = new Map<string, SmartRouteDecision>();
    for (const [category, ref] of Object.entries(p.categoryRoutes)) {
      const decision = resolveRef(ref, byProvider);
      if (decision) byCategory.set(category, decision); // drop unroutable categories
    }
    decisions.set(p, byCategory);

    const c = p.classifier;
    if (c.model && c.providerRef && !byModel.has(c.model)) {
      const target = singleTarget(byProvider.get(c.providerRef));
      // Residency: an llm-router / rules-then-llm classifier egresses the (pre-guardrail)
      // prompt to this target, so it must satisfy the same region/ZDR policy as a served
      // upstream. A target that cannot be proven compliant is DROPPED — the completer
      // then abstains for that model and the policy falls back to local rules / the model
      // router — rather than leaking prompt content to a non-compliant region.
      if (
        target &&
        (!residency || residencyCompliant(target, residency.allowedRegions, residency.requireZdr))
      ) {
        byModel.set(c.model, { target, provider: c.providerRef });
      }
    }
  }

  // Use a caller-supplied completer (tests) if present; else build the real one
  // when any policy configured a wired classifier model+provider.
  const completer =
    deps.completer ?? (byModel.size > 0 ? new GatewayClassifierCompleter(byModel) : undefined);
  const finalDeps: ClassifierDeps = { ...deps, completer };

  return new SmartRouter(new MapSmartRouteResolver(policies), decisions, finalDeps);
}

function singleTarget(decision: SmartRouteDecision | undefined): RouteTarget | undefined {
  return decision?.strategy?.mode === 'single' ? decision.strategy.target : undefined;
}
