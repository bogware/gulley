export const meta = {
  name: 'hotpath-review',
  description: 'Adversarial review of hot-path (data-plane) changes vs origin/main',
  whenToUse:
    'Before merging a change that ci/hotpath-guard.sh flags — edits to the gateway pipeline, budget, cost, cache, routing, or the SSE state machine.',
  phases: [
    { title: 'Scout', detail: 'compute the hot-path diff + touched invariants' },
    { title: 'Review', detail: 'one reviewer per invariant dimension' },
    { title: 'Verify', detail: 'adversarially refute each finding' },
  ],
};

// The invariant dimensions this pass looks through. Each is reviewed independently
// so a reviewer stays focused on one failure mode rather than skimming for "bugs".
const DIMENSIONS = [
  {
    key: 'fidelity-teardown',
    prompt:
      'raw-byte response fidelity and the SINGLE centralized teardown(). Look for: a second place budget-commit/ledger/audit/cache-store/telemetry can run or be skipped; buffering introduced on the default path; a response path that bypasses reply.hijack() semantics or the inactivity watchdog / backpressure.',
  },
  {
    key: 'budget',
    prompt:
      'budget reserve/commit. Look for: a reservation that can leak (not released first-and-independently of durable sinks in teardown), a non-worst-case reservation, a missing partial-spend meter on abort/failover, or a TOCTOU window.',
  },
  {
    key: 'failover',
    prompt:
      'failover and the circuit breaker. Look for: any re-route AFTER the first byte, a terminal 4xx that trips the breaker, or a breaker/outlier state change that is not preserved by-reference across a live route swap.',
  },
  {
    key: 'metering',
    prompt:
      'metering correctness. Look for: metering from a canonical token field instead of raw provider `usage`, per-provider inclusion semantics broken, or a golden cost fixture silently changed.',
  },
  {
    key: 'cache-scope',
    prompt:
      'cache safety. Look for: a cache key not partitioned by authz scope (cross-tenant bleed), or a PII/secret-flagged response that becomes cacheable.',
  },
];

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          detail: { type: 'string' },
          failureScenario: { type: 'string', description: 'concrete inputs → wrong outcome' },
        },
        required: ['title', 'file', 'detail', 'failureScenario'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean', description: 'true only if the defect genuinely reproduces' },
    reasoning: { type: 'string' },
  },
  required: ['real', 'reasoning'],
};

phase('Scout');
const scout = await agent(
  'Run `bash ci/hotpath-guard.sh` and `git diff --name-only origin/main...HEAD`, then read the changed hot-path files. Return the diff context a reviewer needs: the list of changed hot-path files and, for each, the specific hunks that changed. Be concise but include the actual changed code.',
  { label: 'scout:diff' },
);

phase('Review');
const results = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(
      `You are reviewing a change to the Gulley gateway HOT PATH for ONE invariant: ${d.prompt}\n\nDiff context from the scout:\n${scout}\n\nReport only genuine defects in THIS dimension. If the change is clean for this dimension, return an empty findings array. Do not invent issues.`,
      { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  (review, d) =>
    parallel(
      (review?.findings ?? []).map(
        (f) => () =>
          agent(
            `Adversarially VERIFY this hot-path finding — try to REFUTE it. Default to real=false unless the failure scenario genuinely reproduces given the actual code.\n\nDimension: ${d.key}\nFinding: ${f.title}\nFile: ${f.file}:${f.line ?? '?'}\nClaim: ${f.detail}\nScenario: ${f.failureScenario}`,
            { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
          ).then((v) => ({ dimension: d.key, ...f, verdict: v })),
      ),
    ),
);

const confirmed = results
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict?.real);

log(
  `hotpath-review: ${confirmed.length} confirmed finding(s) across ${DIMENSIONS.length} dimensions.`,
);
return { confirmed };
