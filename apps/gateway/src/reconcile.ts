import type { ConfigStore, ConfigVersionStore } from '@gulley/config';
import type { SecretResolver } from '@gulley/core';
import type { ClassifierBreaker, ClassifierEmbedder } from '@gulley/routing';
import { type CentroidStore, type ConfigSubscriber, SignalGate } from '@gulley/storage';
import { buildRoutesFromDocument } from './config-builder';
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
  /** Durable centroid store; present ⇒ exemplar embeddings are persisted/reused
   *  across replicas (requires `model`) instead of re-embedded every reconcile. */
  store?: CentroidStore;
  /** Embedding model id keying persisted centroids (a model change re-embeds). */
  model?: string;
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
      const routes = await buildRoutesFromDocument(doc, this.resolver);
      // Build the smart router BEFORE swapping anything: a malformed policy throws
      // here and the catch keeps the CURRENT routes + smart router intact (never a
      // partial swap), matching the credential-resolution failure contract.
      let smartRouter;
      if (this.smartRouting?.enabled) {
        const policies = parseSmartRoutingPolicies(doc);
        const { embedder, store, model } = this.smartRouting;
        const centroids = embedder
          ? store && model
            ? await buildPersistentCentroids(policies, embedder, store, model)
            : await buildEmbeddingCentroids(policies, embedder, this.embedCache)
          : undefined;
        smartRouter = buildSmartRouter(policies, routes, {
          embedder: this.smartRouting.embedder,
          centroids,
          breaker: this.smartRouting.breaker,
          similarityThreshold: this.smartRouting.similarityThreshold,
        });
      }
      this.holder.swapRoutes(routes);
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
  private stopped = false;

  constructor(
    private readonly subscriber: ConfigSubscriber,
    private readonly reconciler: GatewayReconciler,
    private readonly versions: ConfigVersionStore,
    originId: string,
    /** Extra cleanup on stop (e.g. close the store's DB pool). */
    private readonly cleanup?: () => Promise<void>,
    private readonly retryMs = 5_000,
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
  }

  private async handle(version: number): Promise<void> {
    const ok = await this.reconciler.reconcile();
    if (ok) this.gate.observe(version);
    else this.scheduleRetry(); // transient failure — retry so we don't stay stale
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
    if (ok) this.gate.observe(version);
    else this.scheduleRetry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.subscriber.close();
    await this.cleanup?.();
  }
}
