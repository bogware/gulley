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
 *
 * Evaluation errors FAIL CLOSED on both sides. A DENY rule that errors — a type
 * mismatch, a missing field, or a step-limit trip, all reachable through the
 * attacker-controlled `request.body` — is treated as a MATCH (denied), so a crafted
 * body can never dodge a deny by making it throw or yield a non-boolean (e.g. sending
 * `"max_tokens": "999999"` to defeat `deny: request.body.max_tokens > 100000`). An
 * ALLOW rule that errors is a non-match, so an all-erroring allow-list is denied.
 *
 * A deny rule over an OPTIONAL field must guard it so a legitimately-absent field is a
 * clean non-match, not a fail-closed deny: `&&` short-circuits on a false left, so
 * `has(request.body.x) && request.body.x > 100000` denies only when `x` is present and
 * over-limit (or present but hostile → error → deny) and allows when `x` is absent.
 */
export interface CelAuthorizerHooks {
  /** A rule threw at evaluation. Surfaced here for observability: a DENY-rule error now
   *  fails CLOSED (denied) and an ALLOW-rule error is a non-match, so a typo'd rule no
   *  longer silently permits — but the hook is still how you SEE that a rule is erroring
   *  (e.g. a deny rule referencing an unguarded optional field on every request). */
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
    // Deny is fail-closed: a deny rule that ERRORS (attacker-controllable via the body)
    // counts as a match, so it can't be dodged by making the rule throw. Only a clean
    // `false` skips a deny.
    for (const rule of this.deny) {
      const r = this.evalRule(rule, root);
      if (r !== 'no-match') {
        return {
          allowed: false,
          reason: r === 'error' ? `deny_error:${rule.name}` : `deny:${rule.name}`,
        };
      }
    }
    // Allow is fail-closed the other way: an erroring allow rule is a non-match, so an
    // all-erroring allow-list denies.
    if (this.allow.length > 0) {
      const hit = this.allow.find((r) => this.evalRule(r, root) === 'match');
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

  /** Evaluate one rule to a clean boolean, or `error` when it throws / yields a
   *  non-boolean. The deny and allow paths treat `error` differently (see authorize):
   *  deny fails closed as a match, allow fails closed as a non-match. */
  private evalRule(
    rule: CompiledRule,
    root: Record<string, unknown>,
  ): 'match' | 'no-match' | 'error' {
    try {
      return rule.program.evalBool(root) ? 'match' : 'no-match';
    } catch (err) {
      try {
        this.hooks.onError?.(err, rule.name);
      } catch {
        /* observability must never affect authorization */
      }
      return 'error';
    }
  }
}
