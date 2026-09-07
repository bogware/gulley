import { modelPatternMatches } from './model-policy';

/**
 * Cascade routing — attempt a cheap model first, escalate to a stronger one only when
 * the cheap response is inadequate. The gateway buffers the cheap (tier-0) response,
 * reads the provider's own `stop_reason`, and — if it signals inadequacy (a refusal, a
 * truncation, a blown context window, an unserved tool call) — RE-DISPATCHES the same
 * request to the configured stronger model before any byte reaches the client. Both
 * upstream legs are billed (the cheap attempt really spent), so a cascade trades a
 * little latency + the cheap-leg cost for far fewer expensive-model calls on the easy
 * majority of requests.
 *
 * v1 (deployment-wide, env-config): a SINGLE escalation step, triggered by the
 * provider's deterministic `stop_reason` (no operator-regex or judge-model signal —
 * those, plus N-tier ladders and per-tenant/DB config, are follow-ups). Off by default
 * (empty CASCADE_POLICY). The escalated leg is a single attempt (no tier-1 failover).
 */

/** Provider stop_reasons that, by default, mark a tier-0 response as inadequate.
 *  `refusal` (won't answer), `max_tokens` (truncated), `model_context_window_exceeded`
 *  (too small a context). `tool_use` is opt-in per policy (escalate when the cheap
 *  model wants a tool it can't/shouldn't run). */
export const DEFAULT_ESCALATION_STOP_REASONS = [
  'refusal',
  'max_tokens',
  'model_context_window_exceeded',
];

export interface CascadePolicy {
  /** Anchored glob matched against the RESOLVED requested model — a match makes that
   *  model tier-0 of a cascade. */
  model: string;
  /** The stronger model to escalate to (tier-1). Must differ from a tier-0 match. */
  escalateTo: string;
  /** Provider stop_reasons that trigger escalation. */
  stopReasons: string[];
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
}

/** Parse CASCADE_POLICY (a JSON array of {model, escalateTo, stopReasons?}). THROWS on
 *  malformed input so a bad policy fails boot rather than silently disabling cascade.
 *  Returns [] for empty/unset. */
export function parseCascadePolicy(raw: string | undefined): CascadePolicy[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('CASCADE_POLICY is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('CASCADE_POLICY must be a JSON array');
  return parsed.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const model = typeof e['model'] === 'string' ? e['model'].trim() : '';
    const escalateTo = typeof e['escalateTo'] === 'string' ? e['escalateTo'].trim() : '';
    if (!model || !escalateTo) {
      throw new Error(`CASCADE_POLICY[${i}] requires non-empty "model" and "escalateTo"`);
    }
    const stopReasons = strList(e['stopReasons']);
    return {
      model,
      escalateTo,
      stopReasons: stopReasons.length > 0 ? stopReasons : [...DEFAULT_ESCALATION_STOP_REASONS],
    };
  });
}

/** The first policy whose `model` glob matches the resolved model, or undefined. A
 *  policy whose escalateTo equals the requested model is ignored (nothing to escalate
 *  to), preventing a no-op / self-cascade. */
export function matchCascade(
  policies: readonly CascadePolicy[],
  model: string,
): CascadePolicy | undefined {
  return policies.find((p) => p.escalateTo !== model && modelPatternMatches(p.model, model));
}

/** Whether a tier-0 response's stop_reason triggers escalation. A missing stop_reason
 *  never escalates (we only escalate on a POSITIVE inadequacy signal — fail-open to the
 *  cheap response, which is a valid answer). */
export function shouldEscalate(
  policy: CascadePolicy,
  stopReason: string | null | undefined,
): boolean {
  return typeof stopReason === 'string' && policy.stopReasons.includes(stopReason);
}
