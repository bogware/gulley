import { computeCost, type RateResolver } from '@gulley/cost';
import { allTargets, type ModelRouteRule, type ModelRouter } from '@gulley/routing';
import type { CascadePolicy } from './cascade';
import type { ProviderRoute } from './routes/messages';

/** What the unpriced-model check reads: every place an OPERATOR names a model. */
export interface UnpricedCheckInput {
  /** Provider names the gateway can serve (route targets). */
  providers: readonly string[];
  /** Providers whose models are free to serve (local runtimes): never flagged. */
  freeProviders?: readonly string[];
  /** Route-group `modelMap` upstream ids, with the provider they are sent to. */
  modelMaps?: ReadonlyArray<{ provider: string; model: string }>;
  /** Model-router rules: an alias `target` (else an exact `pattern`) with its provider hint. */
  aliasRules?: readonly ModelRouteRule[];
  downshiftModel?: string;
  cascade?: readonly CascadePolicy[];
  rateResolver?: RateResolver;
}

const PROBE = {
  inputTokens: 1,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 1,
  seen: true,
} as const;

/**
 * Every model the OPERATOR pointed the gateway at — model-alias targets (or exact alias
 * patterns), the budget downshift model, cascade escalation targets and route-group
 * `modelMap` upstream ids — that has no rate in the seed table or the catalog. Such a
 * model meters $0 on every request it serves, so it is surfaced on /ready (and by
 * `gulley doctor`) instead of silently bypassing budgets and chargeback.
 *
 * A model with a known provider is checked against that provider; one without (an alias
 * target served by whichever route matches) is priced if ANY configured, non-free
 * provider prices it. Glob patterns are not models and are skipped. Pure and cheap (a
 * few dozen `computeCost` calls at most), so it can run per readiness probe. Returns
 * sorted `provider/model` (or bare `model`) labels.
 */
export function unpricedModels(input: UnpricedCheckInput): string[] {
  const free = new Set(input.freeProviders ?? []);
  const paidProviders = input.providers.filter((p) => !free.has(p));
  // model -> provider hint (a hinted entry wins over an unhinted duplicate)
  const candidates = new Map<string, string | undefined>();
  const add = (model: string | undefined, provider?: string): void => {
    if (!model || model.includes('*')) return;
    if (!candidates.has(model) || (provider !== undefined && candidates.get(model) === undefined))
      candidates.set(model, provider);
  };

  for (const m of input.modelMaps ?? []) add(m.model, m.provider);
  for (const rule of input.aliasRules ?? []) add(rule.target ?? rule.pattern, rule.provider);
  add(input.downshiftModel);
  for (const p of input.cascade ?? []) add(p.escalateTo);

  const priced = (provider: string, model: string): boolean =>
    free.has(provider) || computeCost(provider, model, PROBE, input.rateResolver).priced;

  const out: string[] = [];
  for (const [model, hint] of candidates) {
    const ok =
      hint !== undefined
        ? priced(hint, model)
        : // No paid provider at all (a purely local deployment) ⇒ nothing can be unpriced.
          paidProviders.length === 0 || paidProviders.some((p) => priced(p, model));
    if (!ok) out.push(hint !== undefined ? `${hint}/${model}` : model);
  }
  return out.sort();
}

/** The data-plane adapter: read the inputs off the live gateway context. */
export function unpricedConfiguredModels(ctx: {
  routes: readonly ProviderRoute[];
  modelRouter?: ModelRouter;
  budgetDownshift?: { model: string };
  cascade?: readonly CascadePolicy[];
  rateResolver?: RateResolver;
  freeProviders?: readonly string[];
}): string[] {
  const providers = new Set<string>();
  const modelMaps: Array<{ provider: string; model: string }> = [];
  for (const route of ctx.routes) {
    for (const t of allTargets(route.strategy)) {
      providers.add(t.provider);
      for (const model of Object.values(t.modelMap ?? {}))
        modelMaps.push({ provider: t.provider, model });
    }
  }
  return unpricedModels({
    providers: [...providers],
    freeProviders: ctx.freeProviders,
    modelMaps,
    aliasRules: ctx.modelRouter?.rules() ?? [],
    downshiftModel: ctx.budgetDownshift?.model,
    cascade: ctx.cascade,
    rateResolver: ctx.rateResolver,
  });
}
