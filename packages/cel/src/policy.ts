import { type CompileOptions, compile, Program } from './program';

export type RuleEffect = 'allow' | 'deny';

export interface AuthzRuleConfig {
  /** A CEL boolean expression over the request/principal activation. */
  expr: string;
  /** `deny` blocks the request when it matches; `allow` permits it. */
  effect: RuleEffect;
  /** Optional label surfaced in the decision reason / audit. */
  name?: string;
}

export interface AuthzDecision {
  allowed: boolean;
  /** Which rule decided (e.g. `deny:no-experimental`, `allow-list`). */
  reason?: string;
}

interface CompiledRule {
  program: Program;
  name: string;
}

/**
 * CEL-based authorization with a deny-first, allow-list model:
 *   1. if any `deny` rule matches → denied;
 *   2. else if `allow` rules exist → at least one must match, otherwise denied;
 *   3. else (no allow rules) → allowed (only deny rules gate).
 * A rule that errors at evaluation (e.g. a missing attribute) is treated as a
 * non-match, so a malformed request can't crash authorization — an allow-list
 * with only erroring rules therefore fails closed (denied).
 */
export interface CelAuthorizerHooks {
  /** A rule threw at evaluation (it is treated as a non-match). Without a hook the
   *  failure was invisible: a typo'd root variable in a DENY rule made every
   *  evaluation throw and every call pass, silently. */
  onError?: (err: unknown, rule: string) => void;
}

export class CelAuthorizer {
  private readonly allow: CompiledRule[] = [];
  private readonly deny: CompiledRule[] = [];

  constructor(
    rules: AuthzRuleConfig[],
    compileOpts?: CompileOptions,
    private readonly hooks: CelAuthorizerHooks = {},
  ) {
    rules.forEach((r, i) => {
      const compiled: CompiledRule = {
        program: compile(r.expr, compileOpts),
        name: r.name ?? `${r.effect}[${i}]`,
      };
      (r.effect === 'deny' ? this.deny : this.allow).push(compiled);
    });
  }

  authorize(root: Record<string, unknown>): AuthzDecision {
    for (const rule of this.deny) {
      if (this.match(rule, root)) return { allowed: false, reason: `deny:${rule.name}` };
    }
    if (this.allow.length > 0) {
      const hit = this.allow.find((r) => this.match(r, root));
      return hit
        ? { allowed: true, reason: `allow:${hit.name}` }
        : { allowed: false, reason: 'no allow rule matched' };
    }
    return { allowed: true };
  }

  /** True if any rule reads the given attribute path (e.g. `request.body`), so
   *  the caller can decide whether to populate it. */
  reads(path: string): boolean {
    return [...this.allow, ...this.deny].some((r) => r.program.reads(path));
  }

  get ruleCount(): number {
    return this.allow.length + this.deny.length;
  }

  private match(rule: CompiledRule, root: Record<string, unknown>): boolean {
    try {
      return rule.program.evalBool(root);
    } catch (err) {
      try {
        this.hooks.onError?.(err, rule.name);
      } catch {
        /* observability must never affect authorization */
      }
      return false; // an erroring rule is a non-match (see class doc)
    }
  }
}
