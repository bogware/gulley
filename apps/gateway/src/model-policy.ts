import type { ConfigDocument } from '@gulley/config';

/**
 * Central model allow/deny policy — the deployment's team-wide model governance.
 *
 * Single-tenant v1: one deployment serves one team/org, so the policy applies
 * gateway-wide (the union of every `policies` config entity that carries a model
 * allow/deny, plus optional env MODEL_ALLOW/MODEL_DENY) — mirroring how model
 * aliases and per-workspace guardrails apply globally in v1. It is enforced at the
 * authz step (after aliasing, so it governs the RESOLVED model) and filters the
 * advertised GET /v1/models list. Model PINNING is expressed via `model-aliases`
 * (already wired), so this policy covers only allow/deny.
 *
 * Deny-first, allow-as-allowlist: a model matching any deny pattern is rejected;
 * else, if any allow pattern is configured, the model must match one; else allowed.
 * Patterns support a trailing/embedded `*` glob (e.g. `claude-*`, `gpt-4o-*`).
 */
export interface ModelPolicy {
  allow: string[];
  deny: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anchored glob match: `*` matches any run of characters; otherwise exact. */
export function modelPatternMatches(pattern: string, model: string): boolean {
  if (pattern === '*' || pattern === model) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
  return re.test(model);
}

/** Deny-first allow-list evaluation. */
export function modelAllowedByPolicy(policy: ModelPolicy, model: string): boolean {
  if (policy.deny.some((p) => modelPatternMatches(p, model))) return false;
  if (policy.allow.length > 0) return policy.allow.some((p) => modelPatternMatches(p, model));
  return true;
}

/** A policy is meaningful only if it actually constrains something. */
export function isEmptyModelPolicy(policy: ModelPolicy | undefined): boolean {
  return !policy || (policy.allow.length === 0 && policy.deny.length === 0);
}

/** Union two model policies (allow ∪ allow, deny ∪ deny). Used to compose the env
 *  base policy with the config-document policy on reconcile, so a DB config with no
 *  model policy can never DROP an env-set deny floor (it only adds). Returns
 *  undefined when both are empty. */
export function unionModelPolicy(
  a: ModelPolicy | undefined,
  b: ModelPolicy | undefined,
): ModelPolicy | undefined {
  if (isEmptyModelPolicy(a) && isEmptyModelPolicy(b)) return undefined;
  const allow = new Set<string>([...(a?.allow ?? []), ...(b?.allow ?? [])]);
  const deny = new Set<string>([...(a?.deny ?? []), ...(b?.deny ?? [])]);
  return { allow: [...allow], deny: [...deny] };
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
}

/**
 * Build the gateway-wide model policy from the config document's `policies` entities.
 * An entity contributes when its `config` carries an `allow` and/or `deny` array of
 * model patterns. Folded by UNION (deny lists union; allow lists union — each entity
 * adds allowed models). Returns undefined when no entity carries a model policy.
 */
export function buildModelPolicy(doc: ConfigDocument): ModelPolicy | undefined {
  const allow = new Set<string>();
  const deny = new Set<string>();
  let found = false;
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const p of ws.policies ?? []) {
        const a = strList(p.config['allow']);
        const d = strList(p.config['deny']);
        if (a.length === 0 && d.length === 0) continue;
        found = true;
        for (const m of a) allow.add(m);
        for (const m of d) deny.add(m);
      }
    }
  }
  return found ? { allow: [...allow], deny: [...deny] } : undefined;
}

/** Build a model policy from comma-separated env allow/deny lists (the env-config
 *  path, which has no config document). Returns undefined when both are empty. */
export function modelPolicyFromEnv(allow: string, deny: string): ModelPolicy | undefined {
  const a = allow
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const d = deny
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return a.length === 0 && d.length === 0 ? undefined : { allow: a, deny: d };
}
