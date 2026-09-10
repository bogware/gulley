/**
 * Smart-routing classifier engine (M15 Phase C). Turns a prompt into a category
 * label for a {@link SmartRoutingPolicy}, via one of three operator-selectable
 * backends. Pure + dependency-light: the real embedding provider, model caller,
 * and centroid store are injected as structural ports (the gateway wires them),
 * so this package gains no new dependency.
 *
 * Contract: `classifyRequest` returns a category label (a key the caller maps
 * through `policy.categoryRoutes`) or `undefined` — and it returns `undefined`,
 * never throws, on a timeout, an upstream error, a missing port, an open breaker,
 * or an abstention. So the caller's fallback (leave the strategy at the model
 * router) is always a plain no-op. Abstention is not a fault; only a timeout or a
 * thrown upstream error records a breaker failure.
 */
import type { ClassifierRule, SmartRoutingPolicy } from './smart-router';

/** Embeds prompt text to a vector (the semantic-cache EmbeddingProvider). */
export interface ClassifierEmbedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

/** Nearest labeled centroid lookup for `embedding-nearest-label`. `scope` selects
 *  the taxonomy; returns matches ranked by cosine similarity (higher = closer). */
export interface CentroidIndex {
  nearest(
    scope: string,
    embedding: number[],
    topK: number,
  ): Promise<Array<{ label: string; score: number }>>;
}

/** The raw token usage of one classifier sub-call (for metering), read from the
 *  provider's own usage — never from canonical fields. */
export interface ClassifierUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** One llm-router completion: the raw text plus (for metering) the sub-call's
 *  usage, when the completer made a billable upstream call. */
export interface ClassifierCompletion {
  text: string;
  usage?: ClassifierUsage;
}

/** A minimal text-completion port for `llm-router` (the gateway wires the
 *  provider adapter's `forward`). Returns the model's completion text + usage. */
export interface ClassifierCompleter {
  complete(model: string, prompt: string, signal?: AbortSignal): Promise<ClassifierCompletion>;
}

/** Per-request sink for a classifier sub-call's usage. The engine invokes it (via
 *  the caller) ONLY when the policy sets `meterClassifier`; the gateway meters the
 *  spend against the tenant budget with a `proxy.classify` ledger + audit line. */
export type ClassifierSpendSink = (usage: ClassifierUsage) => void;

/** Breaker keyed by a synthetic classifier name; open ⇒ skip (fail open). */
export interface ClassifierBreaker {
  isOpen(key: string): boolean;
  record(key: string, ok: boolean): void;
}

/** The resolved outcome of one classification attempt, for observability. `timeout`
 *  specifically means the outer race budget fired before the embed/completer replied —
 *  a sustained rate of it means the classify budget is mis-tuned and semantic routing
 *  is silently dead-on-arrival (the failure the HIGH finding describes). */
export type ClassifierOutcome = 'ok' | 'abstain' | 'timeout' | 'error';

export interface ClassifierDeps {
  embedder?: ClassifierEmbedder;
  centroids?: CentroidIndex;
  completer?: ClassifierCompleter;
  /** Cosine-similarity floor for `embedding-nearest-label` (default 0.6). */
  similarityThreshold?: number;
  /** Default classifier timeout in ms when a policy omits one (default 200). NOTE:
   *  this OUTER race budget must be strictly GREATER than the embedder/completer's own
   *  inner HTTP timeout, or the two race and classification aborts before the upstream
   *  can reply. The gateway wires a dedicated SMART_ROUTING_CLASSIFY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Optional breaker; when open the classifier is skipped without a call. */
  breaker?: ClassifierBreaker;
  /** Fire-and-forget observability hook, invoked once per classification with its
   *  outcome. Never throws into the classifier (called in a try/catch). */
  onOutcome?: (outcome: ClassifierOutcome) => void;
}

/** Distinguishes an outer-race timeout from any other upstream error, so callers /
 *  observability can tell a mis-tuned budget (routing silently dead) apart from a
 *  genuine classifier fault. */
export class ClassifierTimeoutError extends Error {
  constructor() {
    super('classifier timeout');
    this.name = 'ClassifierTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_SIMILARITY = 0.6;
/** Cap the text fed to regex/prompt so an adversarial prompt can't blow up a
 *  (trusted, operator-authored) regex or balloon a classification prompt. */
const TEXT_CAP = 4096;

/** Run ordered rules over the prompt; first matching rule's category wins. A rule
 *  matches if ANY of its specified predicates holds (short-length OR keyword OR
 *  regex). A malformed regex is skipped, not fatal. Synchronous — no upstream. */
export function runRules(rules: readonly ClassifierRule[], text: string): string | undefined {
  const lower = text.toLowerCase();
  const capped = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  for (const rule of rules) {
    if (rule.maxChars !== undefined && text.length <= rule.maxChars) return rule.category;
    if (rule.anyOf && rule.anyOf.some((s) => s.length > 0 && lower.includes(s.toLowerCase()))) {
      return rule.category;
    }
    if (rule.regex) {
      try {
        if (new RegExp(rule.regex, 'i').test(capped)) return rule.category;
      } catch {
        // Skip a malformed operator regex rather than failing the whole request.
      }
    }
  }
  return undefined;
}

function buildClassifyPrompt(text: string, labels: readonly string[]): string {
  const snippet = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  return (
    `Classify the request into exactly one of these categories: ${labels.join(', ')}.\n` +
    'Answer with only the category name, nothing else.\n\n' +
    `Request:\n${snippet}\n\nCategory:`
  );
}

/** Map a model completion to one of the candidate labels (exact, else contained). */
function matchLabel(completion: string, labels: readonly string[]): string | undefined {
  const c = completion.trim().toLowerCase();
  for (const l of labels) if (l.toLowerCase() === c) return l;
  for (const l of labels) if (c.includes(l.toLowerCase())) return l;
  return undefined;
}

/** Race an async op against a timeout, aborting the op on expiry (or when a
 *  parent signal aborts). Rejects on timeout so the caller falls back. */
async function withTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClassifierTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([op(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParentAbort);
  }
}

async function llmClassify(
  policy: SmartRoutingPolicy,
  text: string,
  model: string,
  deps: ClassifierDeps,
  signal: AbortSignal,
  onSpend?: ClassifierSpendSink,
): Promise<string | undefined> {
  if (!deps.completer) return undefined;
  const labels = Object.keys(policy.categoryRoutes);
  if (labels.length === 0) return undefined;
  const completion = await deps.completer.complete(
    model,
    buildClassifyPrompt(text, labels),
    signal,
  );
  // Report the sub-call's usage for metering (only when the caller wired a sink,
  // which it does only for a `meterClassifier` policy).
  if (completion.usage && onSpend) onSpend(completion.usage);
  return matchLabel(completion.text, labels);
}

async function embeddingClassify(
  policy: SmartRoutingPolicy,
  text: string,
  deps: ClassifierDeps,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!deps.embedder || !deps.centroids) return undefined;
  // Cap the egressed text like the rules/LLM paths — an adversarial or simply large
  // prompt must not force an unbounded embedding-API payload (extra cost + latency on
  // the hot path, and a larger unmasked-prompt egress than the other backends allow).
  const capped = text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  const embedding = await deps.embedder.embed(capped, signal);
  const matches = await deps.centroids.nearest(policy.name, embedding, 1);
  const top = matches[0];
  const threshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY;
  return top && top.score >= threshold ? top.label : undefined;
}

/**
 * Classify a request under a policy. Returns a category label (a key into
 * `policy.categoryRoutes`) or `undefined`. Never throws.
 */
export async function classifyRequest(
  policy: SmartRoutingPolicy,
  text: string,
  deps: ClassifierDeps,
  parentSignal?: AbortSignal,
  onSpend?: ClassifierSpendSink,
): Promise<string | undefined> {
  const key = `smart:${policy.name}`;
  if (deps.breaker?.isOpen(key)) return undefined;

  const spec = policy.classifier;
  const timeoutMs = spec.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = spec.model;
  try {
    let category: string | undefined;
    if (spec.mode === 'rules-then-llm') {
      category = runRules(spec.rules ?? [], text);
      if (category === undefined && model) {
        category = await withTimeout(
          (s) => llmClassify(policy, text, model, deps, s, onSpend),
          timeoutMs,
          parentSignal,
        );
      }
    } else if (spec.mode === 'llm-router') {
      if (!model) return undefined;
      category = await withTimeout(
        (s) => llmClassify(policy, text, model, deps, s, onSpend),
        timeoutMs,
        parentSignal,
      );
    } else {
      category = await withTimeout(
        (s) => embeddingClassify(policy, text, deps, s),
        timeoutMs,
        parentSignal,
      );
    }
    deps.breaker?.record(key, true);
    emitOutcome(deps, category !== undefined ? 'ok' : 'abstain');
    return category;
  } catch (err) {
    deps.breaker?.record(key, false);
    emitOutcome(deps, err instanceof ClassifierTimeoutError ? 'timeout' : 'error');
    return undefined;
  }
}

/** Fire the observability hook without ever letting it perturb classification. */
function emitOutcome(deps: ClassifierDeps, outcome: ClassifierOutcome): void {
  if (!deps.onOutcome) return;
  try {
    deps.onOutcome(outcome);
  } catch {
    /* observability hook must never affect the classifier */
  }
}
