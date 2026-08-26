import type { ConfigStore, ConfigVersionStore } from '@gulley/config';
import type { SecretResolver } from '@gulley/core';
import { type ConfigSubscriber, SignalGate } from '@gulley/storage';
import { buildRoutesFromDocument } from './config-builder';
import type { RouteHolder } from './routes/messages';

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

  constructor(
    private readonly holder: RouteHolder,
    private readonly store: ConfigStore,
    private readonly resolver: SecretResolver,
    private readonly log?: ReconcileLog,
  ) {}

  /** Trigger a reconcile; serialized behind any in-flight one. */
  reconcile(): Promise<void> {
    this.chain = this.chain.catch(() => undefined).then(() => this.run());
    return this.chain;
  }

  private async run(): Promise<void> {
    try {
      const doc = await this.store.exportDocument('*');
      const routes = await buildRoutesFromDocument(doc, this.resolver);
      this.holder.swapRoutes(routes);
      this.log?.info(`config reconciled: ${routes.length} routes active`);
    } catch (err) {
      // Old routes stay intact — never a partial or credential-less swap.
      this.log?.error(err, 'config reconcile failed; keeping current config');
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

  constructor(
    private readonly subscriber: ConfigSubscriber,
    private readonly reconciler: GatewayReconciler,
    private readonly versions: ConfigVersionStore,
    originId: string,
  ) {
    this.gate = new SignalGate(originId);
  }

  async start(): Promise<void> {
    this.subscriber.onSignal((sig) => {
      if (this.gate.accept(sig)) void this.reconciler.reconcile();
    });
    await this.subscriber.start();
    await this.resync();
  }

  /** Read the durable version + reconcile from the latest document. */
  async resync(): Promise<void> {
    this.gate.observe(await this.versions.currentVersion());
    await this.reconciler.reconcile();
  }

  async stop(): Promise<void> {
    await this.subscriber.close();
  }
}
