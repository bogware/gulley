import type { ConfigStore, ConfigVersionStore } from '@gulley/config';
import type { SecretResolver } from '@gulley/core';
import type {
  CentroidIndex,
  ClassifierBreaker,
  ClassifierEmbedder,
  ClassifierOutcome,
} from '@gulley/routing';
import { type CentroidStore, type ConfigSubscriber, SignalGate } from '@gulley/storage';
import { buildModelRouterFromDocument, buildRoutesFromDocument } from './config-builder';
import { buildModelPolicy, unionModelPolicy } from './model-policy';
import { isEmptyResidencyPolicy, residencyAllowedRegions } from './residency-policy';
import type { RouteHolder } from './routes/messages';
import {
  buildEmbeddingCentroids,
  buildPersistentCentroids,
  type EmbeddingCache,
} from './smart-classifier-embedding';
import { buildSmartRouter } from './smart-router';
import { parseSmartRoutingPolicies } from './smart-routing-config';

/** Smart-routing reconcile options; absent/disabled ⇒ the smart router is never
 *  built and the data plane ignores any smartRoutingPolicies in the document. */
export interface SmartRoutingReconcile {
  enabled: boolean;
  /** Embedder for `embedding-nearest-label` centroids; absent ⇒ embedding
   *  policies abstain (fail open to the model router). */
  embedder?: ClassifierEmbedder;
  /** Breaker short-circuiting a persistently-failing llm/embedding classifier. */
  breaker?: ClassifierBreaker;
  /** Cosine-similarity floor for embedding classification (engine default 0.6). */
  similarityThreshold?: number;
  /** Outer classifier race budget (ms). MUST exceed the embedder/completer inner HTTP
   *  timeout, or every classification aborts before the upstream replies (semantic
   *  routing silently dead). Absent ⇒ the engine default (200ms) — too low for a real
   *  embed/LLM call, so the gateway always wires SMART_ROUTING_CLASSIFY_TIMEOUT_MS. */
  classifyTimeoutMs?: number;
  /** Observability hook for each classification outcome (ok|abstain|timeout|error). */
  onOutcome?: (outcome: ClassifierOutcome) => void;
  /** Durable centroid store; present ⇒ exemplar embeddings are persisted/reused
   *  across replicas (requires `model`) instead of re-embedded every reconcile. */
  store?: CentroidStore;
  /** Embedding model id keying persisted centroids (a model change re-embeds). */
  model?: string;
  /** pgvector ANN index (M22 C); present ⇒ request-time nearest-label is an indexed
   *  SQL query instead of an in-memory scan (requires `store` + `model`). */
  annIndex?: CentroidIndex;
}

export interface ReconcileLog {
  info(msg: string): void;
  error(err: unknown, msg: string): void;
}

/**
 * Drives a live config reconcile: reads the current document from the durable
 * store, builds the new route table (resolving provider secret ARNs), and swaps
 * it into the holder — preserving the ctx object and all its live state
 * (breaker/scoreboard/outlier/budgets/counters/connections) by reference. It is
 * single-flight (overlapping triggers serialize) and fail-safe: any build or
 * secret-resolution failure aborts the swap and KEEPS the current config, so a
 * bad reconcile can never point a live route at an unresolved credential.
 */
export class GatewayReconciler {
  private chain: Promise<void> = Promise.resolve();
  // Memoize exemplar embeddings across reconciles so an unchanged embedding
  // policy is not re-embedded on every config apply.
  private readonly embedCache: EmbeddingCache = new Map();

  constructor(
    private readonly holder: RouteHolder,
    private readonly store: ConfigStore,
    private readonly resolver: SecretResolver,
    private readonly log?: ReconcileLog,
    private readonly smartRouting?: SmartRoutingReconcile,
  ) {}

  /** Trigger a reconcile; serialized behind any in-flight one. Resolves to true
   *  if the swap succeeded, false if it failed (old config kept). */
  reconcile(): Promise<boolean> {
    const next = this.chain.then(
      () => this.run(),
      () => this.run(),
    );
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async run(): Promise<boolean> {
    try {
      const doc = await this.store.exportDocument('*');
      // Layer per-workspace guardrails over the env-configured global engine (the
      // floor), so a DB policy can only add to it — never drop its output
      // enforcement or managed DLP plugins. ctx is preserved by reference across
      // reconciles, so the floor is stable.
      const routes = await buildRoutesFromDocument(doc, this.resolver, this.holder.ctx.guardrails);
      // Build the smart router BEFORE swapping anything: a malformed policy throws
      // here and the catch keeps the CURRENT routes + smart router intact (never a
      // partial swap), matching the credential-resolution failure contract.
      let smartRouter;
      if (this.smartRouting?.enabled) {
        const policies = parseSmartRoutingPolicies(doc);
        const { store, model, annIndex } = this.smartRouting;
        // Data residency (re-evaluated on EVERY reconcile so a later policy/route change
        // re-checks): the embeddings provider (EMBEDDINGS_*) carries no region/ZDR
        // metadata, so its compliance cannot be PROVEN. Under an active residency policy
        // we therefore disable the embedding classifier entirely — skip exemplar
        // embedding AND request-time classification — so embedding-nearest-label policies
        // abstain to the model router rather than egressing prompt/exemplar content to an
        // unprovable region. (llm-router targets ARE RouteTargets with region/zdr, so
        // buildSmartRouter checks those against `residency` below instead of dropping them
        // wholesale.)
        const residency = this.holder.ctx.residencyPolicy;
        const residencyActive = !isEmptyResidencyPolicy(residency);
        const embedder = residencyActive ? undefined : this.smartRouting.embedder;
        if (
          residencyActive &&
          this.smartRouting.embedder &&
          policies.some((p) => p.classifier.mode === 'embedding-nearest-label')
        ) {
          this.log?.info(
            'residency policy active: embedding-nearest-label classifier disabled ' +
              '(embeddings provider region/ZDR is unprovable); those policies abstain to the model router',
          );
        }
        const centroids = embedder
          ? store && model
            ? await buildPersistentCentroids(policies, embedder, store, model, annIndex)
            : await buildEmbeddingCentroids(policies, embedder, this.embedCache)
          : undefined;
        smartRouter = buildSmartRouter(
          policies,
          routes,
          {
            embedder,
            centroids,
            breaker: this.smartRouting.breaker,
            similarityThreshold: this.smartRouting.similarityThreshold,
            timeoutMs: this.smartRouting.classifyTimeoutMs,
            onOutcome: this.smartRouting.onOutcome,
          },
          residencyActive
            ? {
                allowedRegions: residencyAllowedRegions(residency),
                requireZdr: residency?.requireZdr ?? false,
              }
            : undefined,
        );
      }
      // Build the model router from the document's aliases BEFORE swapping, so a
      // malformed alias throws here (caught → current config kept), never partial.
      const modelRouter = buildModelRouterFromDocument(doc);
      // Central model allow/deny policy from the document's `policies` entities,
      // UNIONED with the stable env floor (envModelPolicy) so a config document with
      // no model policy never drops an env-set MODEL_DENY floor.
      const modelPolicy = unionModelPolicy(this.holder.ctx.envModelPolicy, buildModelPolicy(doc));
      this.holder.swapRoutes(routes);
      this.holder.swapModelRouter(modelRouter);
      this.holder.swapModelPolicy(modelPolicy);
      if (this.smartRouting?.enabled) this.holder.swapSmartRouter(smartRouter);
      this.log?.info(`config reconciled: ${routes.length} routes active`);
      return true;
    } catch (err) {
      // Old routes stay intact — never a partial or credential-less swap.
      this.log?.error(err, 'config reconcile failed; keeping current config');
      return false;
    }
  }
}

/**
 * Subscribes to the config-propagation bus and drives reconciles. A `SignalGate`
 * drops self-emitted + already-seen versions (the dual bus is at-most-once and
 * duplicative). On start it does one full reconcile to load the current config;
 * `resync()` (wired to the bus's reconnect hook) re-reads unconditionally to
 * cover events missed while disconnected.
 */
export class ConfigWatcher {
  private readonly gate: SignalGate;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Highest config version this watcher has successfully reconciled to. Drives
   *  the steady-state poll: reconcile only when the store is ahead of it. */
  private lastVersion = 0;

  constructor(
    private readonly subscriber: ConfigSubscriber,
    private readonly reconciler: GatewayReconciler,
    private readonly versions: ConfigVersionStore,
    originId: string,
    /** Extra cleanup on stop (e.g. close the store's DB pool). */
    private readonly cleanup?: () => Promise<void>,
    private readonly retryMs = 5_000,
    /** Steady-state convergence poll interval (ms); 0 = off (NOTIFY only). */
    private readonly pollMs = 0,
  ) {
    this.gate = new SignalGate(originId);
  }

  async start(): Promise<void> {
    this.subscriber.onSignal((sig) => {
      // Peek (don't advance) so a FAILED reconcile doesn't wedge the cursor and
      // drop this version forever — advance only after a successful swap.
      if (this.gate.shouldAccept(sig)) void this.handle(sig.v);
    });
    await this.subscriber.start();
    await this.resync();
    // Belt-and-suspenders: a bounded poll converges a long-lived replica even if a
    // NOTIFY is never emitted or is missed (the listen socket stays up, so the
    // reconnect resync never fires). Cheap: one currentVersion() read per tick,
    // reconciling only when the store is ahead of what we've applied.
    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
      this.pollTimer.unref?.();
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const version = await this.versions.currentVersion();
      if (version > this.lastVersion) await this.resync();
    } catch {
      // Transient store error — the next tick retries; never throw from the timer.
    }
  }

  private async handle(version: number): Promise<void> {
    const ok = await this.reconciler.reconcile();
    if (ok) {
      this.gate.observe(version);
      if (version > this.lastVersion) this.lastVersion = version;
    } else this.scheduleRetry(); // transient failure — retry so we don't stay stale
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.resync();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Reconcile from the latest document; advance the cursor only on success. */
  async resync(): Promise<void> {
    const version = await this.versions.currentVersion();
    const ok = await this.reconciler.reconcile();
    if (ok) {
      this.gate.observe(version);
      if (version > this.lastVersion) this.lastVersion = version;
    } else this.scheduleRetry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.subscriber.close();
    await this.cleanup?.();
  }
}
