import { OpenAIEmbeddingProvider } from '@gulley/cache';
import type { ClassifierBreaker } from '@gulley/routing';
import {
  createClosableDatabase,
  createListenConnection,
  newOriginId,
  PostgresConfigBus,
  PostgresConfigStore,
  PostgresConfigVersionStore,
} from '@gulley/storage';
import type { Config } from './config';
import { ConfigWatcher, GatewayReconciler, type ReconcileLog } from './reconcile';
import type { RouteHolder } from './routes/messages';
import { buildSecretResolver } from './secrets';

/**
 * Wire M13 config hot-reload for the data plane, or undefined when CONFIG_SOURCE
 * is not 'db'. The gateway reconciles its route table from the Postgres config
 * document (resolving provider secret ARNs) and re-reconciles when the control
 * plane broadcasts a change over the Postgres LISTEN/NOTIFY bus. The dedicated
 * listen connection's reconnect hook triggers a full resync to cover any events
 * missed while disconnected.
 */
export function buildConfigWatcher(
  config: Config,
  holder: RouteHolder,
  log: ReconcileLog,
): ConfigWatcher | undefined {
  if (config.CONFIG_SOURCE !== 'db' || !config.DATABASE_URL) return undefined;

  const { db, close } = createClosableDatabase(config.DATABASE_URL);
  const store = new PostgresConfigStore(db);
  const versions = new PostgresConfigVersionStore(db);
  const resolver = buildSecretResolver(config);
  // Smart-routing classifier deps (only when enabled): the embedding backend
  // reuses the EMBEDDINGS_* provider (short timeout — it is on the classification
  // hot path) for exemplar centroids + prompt embedding; a breaker over the shared
  // circuit breaker short-circuits a persistently-failing classifier.
  const embedder =
    config.SMART_ROUTING_ENABLED && config.EMBEDDINGS_API_KEY
      ? new OpenAIEmbeddingProvider({
          apiKey: config.EMBEDDINGS_API_KEY,
          baseUrl: config.EMBEDDINGS_BASE_URL,
          model: config.EMBEDDINGS_MODEL,
          dimensions: config.EMBEDDINGS_DIMENSIONS,
          timeoutMs: config.SMART_ROUTING_EMBED_TIMEOUT_MS,
        })
      : undefined;
  const breaker: ClassifierBreaker = {
    isOpen: (k) => holder.ctx.breaker.isOpen(k),
    record: (k, ok) =>
      ok ? holder.ctx.breaker.recordSuccess(k) : holder.ctx.breaker.recordFailure(k),
  };
  const reconciler = new GatewayReconciler(holder, store, resolver, log, {
    enabled: config.SMART_ROUTING_ENABLED,
    embedder,
    breaker: config.SMART_ROUTING_ENABLED ? breaker : undefined,
    similarityThreshold: config.SMART_ROUTING_SIMILARITY_THRESHOLD,
  });

  const listen = createListenConnection(config.DATABASE_URL);
  // The reconnect hook references the watcher created just below; a const ref
  // object breaks the construction cycle without a reassigned `let`.
  const ref: { watcher?: ConfigWatcher } = {};
  const subscriber = new PostgresConfigBus(listen, config.CONFIG_NOTIFY_CHANNEL, () => {
    // Fires on every (re)connect — resync to catch anything missed while down.
    void ref.watcher?.resync();
  });
  // On stop, close the store's query pool too (the subscriber closes its own
  // listen connection) so neither is leaked.
  ref.watcher = new ConfigWatcher(subscriber, reconciler, versions, newOriginId(), close);
  return ref.watcher;
}
