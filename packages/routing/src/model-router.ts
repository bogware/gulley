import type { RoutingStrategy } from './types';

/**
 * Model-based routing + aliasing. A requested model id is matched against a set
 * of rules (exact ids beat globs; among globs the most specific — most non-`*`
 * characters — wins) to optionally rewrite the upstream model (aliasing / model
 * pinning) and/or override the routing strategy (a "virtual model" that fans out
 * weighted/failover across backends). Unmatched models keep the requested id and
 * the route's default strategy.
 */
export interface ModelRouteRule {
  /** Exact model id, or a glob with `*` (e.g. `claude-3-5-*`, `gpt-4o`, `*`). */
  pattern: string;
  /** Rewrite the upstream model id (alias / pinning). Omit = keep the requested id. */
  target?: string;
  /** Override the routing strategy for this model (virtual model). */
  strategy?: RoutingStrategy;
  /** Informational provider label (surfaced by `/v1/models`). */
  provider?: string;
}

export interface ModelResolution {
  requested: string;
  /** The id to send upstream (rewritten when the rule pins a target). */
  resolved: string;
  /** A strategy override, when the matched rule defines one. */
  strategy?: RoutingStrategy;
  /** The pattern that matched. */
  matched: string;
  provider?: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Specificity = count of non-`*` characters; a longer literal beats a broad glob. */
function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

export class ModelRouter {
  private readonly exact = new Map<string, ModelRouteRule>();
  private readonly globs: Array<{ rule: ModelRouteRule; re: RegExp }> = [];

  constructor(rules: ModelRouteRule[]) {
    // Most specific first so the first matching glob is the best one.
    const sorted = [...rules].sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    for (const rule of sorted) {
      if (rule.pattern.includes('*')) this.globs.push({ rule, re: globToRegExp(rule.pattern) });
      else if (!this.exact.has(rule.pattern)) this.exact.set(rule.pattern, rule);
    }
  }

  /** Resolve a requested model, or undefined when no rule matches. */
  resolve(model: string): ModelResolution | undefined {
    const rule = this.exact.get(model) ?? this.globs.find((g) => g.re.test(model))?.rule;
    if (!rule) return undefined;
    return {
      requested: model,
      resolved: rule.target ?? model,
      strategy: rule.strategy,
      matched: rule.pattern,
      provider: rule.provider,
    };
  }

  /** Exact (non-glob) model ids known to the router — a discovery source for /v1/models. */
  knownModels(): string[] {
    return [...this.exact.keys()].sort();
  }
}
