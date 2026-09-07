/**
 * Eval-in-the-loop rollout controller (offline golden-set gate).
 *
 * A model/route change (e.g. repointing a model alias from an incumbent model to a
 * candidate) is promoted only after a deterministic eval suite runs BOTH the incumbent
 * and the candidate through the real gateway pipeline and the candidate clears the gate:
 * it must meet an absolute pass-rate threshold AND not regress on any case the incumbent
 * passed (nor blow a cost ceiling). Every decision is hash-chain audited; a promote is
 * applied through the existing config-apply seam.
 *
 * This module is the PURE, deterministic core — scorers and the promote/hold decision.
 * Running the cases is a port ({@link EvalRunner}); prod calls the gateway, tests inject
 * canned {@link EvalResult}s so the gate logic is exercised without a live provider.
 */

/** What running one eval case against one target (incumbent or candidate) produced. */
export interface EvalResult {
  /** Concatenated assistant text of the response (the scorers' primary input). */
  outputText: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Metered request cost in micro-USD, when the gateway reported it; else null. */
  costMicroUsd: number | null;
  latencyMs: number;
  /** True if the gateway flagged the response with a guardrail finding. */
  guardrailFlagged: boolean;
  /** Set when the run itself failed (transport/upstream/timeout) — the case cannot score. */
  error?: string;
}

/** A deterministic check over a single {@link EvalResult}. */
export type Scorer =
  | { kind: 'contains'; text: string; expect?: 'present' | 'absent' }
  | { kind: 'regex'; pattern: string; flags?: string; expect?: 'match' | 'no-match' }
  | { kind: 'json-valid'; requireKeys?: string[] }
  | { kind: 'max-cost-micro-usd'; limit: number }
  | { kind: 'max-latency-ms'; limit: number }
  | { kind: 'max-output-tokens'; limit: number }
  | { kind: 'not-refused' }
  | { kind: 'guardrail-clean' };

/** A scorer plus how it participates in the gate. `critical` scorers anchor the
 *  regression guard — the candidate must not newly fail one the incumbent passed. */
export interface ScorerConfig {
  scorer: Scorer;
  critical?: boolean;
}

export interface EvalCase {
  id: string;
  /** The canonical (Anthropic Messages) request run against each target; `model` is
   *  supplied by the runner per target, so a case omits it. */
  request: {
    system?: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
  };
  scorers: ScorerConfig[];
}

export interface EvalSuite {
  id: string;
  name: string;
  cases: EvalCase[];
}

const REFUSAL_STOP_REASONS = new Set(['refusal', 'content_filtered']);

/** Run one scorer against a result. Pure; never throws (a bad regex fails closed). */
export function runScorer(s: Scorer, r: EvalResult): { pass: boolean; detail: string } {
  switch (s.kind) {
    case 'contains': {
      const present = r.outputText.includes(s.text);
      const want = s.expect ?? 'present';
      const pass = want === 'present' ? present : !present;
      return { pass, detail: `"${s.text}" ${present ? 'present' : 'absent'} (want ${want})` };
    }
    case 'regex': {
      let matched: boolean;
      try {
        matched = new RegExp(s.pattern, s.flags).test(r.outputText);
      } catch {
        return { pass: false, detail: `invalid regex /${s.pattern}/${s.flags ?? ''}` };
      }
      const want = s.expect ?? 'match';
      const pass = want === 'match' ? matched : !matched;
      return { pass, detail: `/${s.pattern}/ ${matched ? 'matched' : 'no match'} (want ${want})` };
    }
    case 'json-valid': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.outputText.trim());
      } catch {
        return { pass: false, detail: 'output is not valid JSON' };
      }
      if (s.requireKeys && s.requireKeys.length > 0) {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { pass: false, detail: 'JSON is not an object; required keys unmet' };
        }
        const obj = parsed as Record<string, unknown>;
        const missing = s.requireKeys.filter((k) => !(k in obj));
        return {
          pass: missing.length === 0,
          detail: missing.length ? `missing keys: ${missing.join(', ')}` : 'all keys present',
        };
      }
      return { pass: true, detail: 'valid JSON' };
    }
    case 'max-cost-micro-usd': {
      if (r.costMicroUsd == null)
        return { pass: false, detail: 'no cost reported (cannot verify ceiling)' };
      return {
        pass: r.costMicroUsd <= s.limit,
        detail: `cost ${r.costMicroUsd} vs limit ${s.limit}`,
      };
    }
    case 'max-latency-ms':
      return {
        pass: r.latencyMs <= s.limit,
        detail: `latency ${r.latencyMs}ms vs limit ${s.limit}ms`,
      };
    case 'max-output-tokens': {
      if (r.outputTokens == null) return { pass: false, detail: 'no output-token count reported' };
      return {
        pass: r.outputTokens <= s.limit,
        detail: `output ${r.outputTokens} vs limit ${s.limit}`,
      };
    }
    case 'not-refused': {
      const refused = r.stopReason != null && REFUSAL_STOP_REASONS.has(r.stopReason);
      return { pass: !refused, detail: refused ? `refused (${r.stopReason})` : 'not refused' };
    }
    case 'guardrail-clean':
      return {
        pass: !r.guardrailFlagged,
        detail: r.guardrailFlagged ? 'guardrail flagged' : 'clean',
      };
  }
}

export interface ScorerOutcome {
  kind: Scorer['kind'];
  critical: boolean;
  pass: boolean;
  detail: string;
}

export interface CaseScore {
  caseId: string;
  /** Whether the run produced a result to score (false ⇒ a transport/upstream error). */
  ran: boolean;
  /** The case passes iff it ran and every scorer passed. */
  pass: boolean;
  scorers: ScorerOutcome[];
  error?: string;
}

/** Score one case's result. A run error ⇒ the case fails (ran:false), never throws. */
export function scoreCase(c: EvalCase, r: EvalResult): CaseScore {
  if (r.error !== undefined) {
    return { caseId: c.id, ran: false, pass: false, scorers: [], error: r.error };
  }
  const scorers: ScorerOutcome[] = c.scorers.map((sc) => {
    const { pass, detail } = runScorer(sc.scorer, r);
    return { kind: sc.scorer.kind, critical: sc.critical ?? false, pass, detail };
  });
  return { caseId: c.id, ran: true, pass: scorers.every((o) => o.pass), scorers };
}

export interface RolloutThresholds {
  /** Candidate must pass at least this fraction of cases (0..1). Default 1.0. */
  minPassRate?: number;
  /** Candidate total cost may exceed the incumbent's by at most this many basis points
   *  (e.g. 500 = +5%). Omitted ⇒ cost regression is not gated. */
  maxCostRegressionBps?: number;
}

/** One target of a rollout: repoint model alias `alias` (in workspace `workspaceId`)
 *  from `fromModel` (incumbent) to `toModel` (candidate). */
export interface RolloutTarget {
  workspaceId: string;
  orgId: string | null;
  /** The model alias to repoint on promote (client-facing name; clients never change). */
  alias: string;
  fromModel: string;
  toModel: string;
}

export interface TargetReport {
  model: string;
  caseScores: CaseScore[];
  passRate: number;
  passed: number;
  total: number;
  /** Sum of per-case cost when every case reported one; null if any was missing. */
  totalCostMicroUsd: number | null;
}

export interface RolloutReport {
  suiteId: string;
  target: RolloutTarget;
  incumbent: TargetReport;
  candidate: TargetReport;
  decision: 'promote' | 'hold';
  reasons: string[];
}

function summarize(
  model: string,
  suite: EvalSuite,
  results: Map<string, EvalResult>,
): TargetReport {
  const caseScores = suite.cases.map((c) => {
    const r = results.get(c.id);
    return r
      ? scoreCase(c, r)
      : { caseId: c.id, ran: false, pass: false, scorers: [], error: 'no result' };
  });
  const passed = caseScores.filter((s) => s.pass).length;
  const total = caseScores.length;
  let totalCost: number | null = 0;
  for (const c of suite.cases) {
    const cost = results.get(c.id)?.costMicroUsd;
    if (cost == null) {
      totalCost = null;
      break;
    }
    totalCost += cost;
  }
  return {
    model,
    caseScores,
    passed,
    total,
    passRate: total === 0 ? 0 : passed / total,
    totalCostMicroUsd: totalCost,
  };
}

/**
 * The gate. Deterministic decision from the two targets' results:
 *  1. candidate pass-rate ≥ minPassRate (default 1.0), and
 *  2. NO regression: the candidate must pass every case the incumbent passed, and
 *  3. cost is within the allowed regression band (when configured and both costs known).
 * Promote iff all hold; otherwise hold (no change applied).
 */
export function decideRollout(
  suite: EvalSuite,
  target: RolloutTarget,
  incumbentResults: Map<string, EvalResult>,
  candidateResults: Map<string, EvalResult>,
  thresholds: RolloutThresholds = {},
): RolloutReport {
  const incumbent = summarize(target.fromModel, suite, incumbentResults);
  const candidate = summarize(target.toModel, suite, candidateResults);
  const minPassRate = thresholds.minPassRate ?? 1.0;
  const reasons: string[] = [];

  if (suite.cases.length === 0) {
    reasons.push('eval suite has no cases; refusing to promote on an empty gate');
    return { suiteId: suite.id, target, incumbent, candidate, decision: 'hold', reasons };
  }

  if (candidate.passRate < minPassRate) {
    reasons.push(
      `candidate pass-rate ${(candidate.passRate * 100).toFixed(1)}% < required ${(minPassRate * 100).toFixed(1)}%`,
    );
  }

  // Regression guard: any case the incumbent passed that the candidate fails.
  const incumbentPass = new Set(incumbent.caseScores.filter((s) => s.pass).map((s) => s.caseId));
  const candidatePass = new Set(candidate.caseScores.filter((s) => s.pass).map((s) => s.caseId));
  const regressions = [...incumbentPass].filter((id) => !candidatePass.has(id));
  if (regressions.length > 0) {
    reasons.push(
      `candidate regressed on ${regressions.length} case(s) the incumbent passed: ${regressions.join(', ')}`,
    );
  }

  if (
    thresholds.maxCostRegressionBps !== undefined &&
    incumbent.totalCostMicroUsd != null &&
    candidate.totalCostMicroUsd != null &&
    incumbent.totalCostMicroUsd > 0
  ) {
    const allowed = incumbent.totalCostMicroUsd * (1 + thresholds.maxCostRegressionBps / 10_000);
    if (candidate.totalCostMicroUsd > allowed) {
      reasons.push(
        `candidate cost ${candidate.totalCostMicroUsd}µ¢ exceeds incumbent+${thresholds.maxCostRegressionBps}bps (${Math.round(allowed)}µ¢)`,
      );
    }
  }

  const decision: 'promote' | 'hold' = reasons.length === 0 ? 'promote' : 'hold';
  if (decision === 'promote')
    reasons.push('candidate cleared the gate: pass-rate met, no regressions, cost within band');
  return { suiteId: suite.id, target, incumbent, candidate, decision, reasons };
}
