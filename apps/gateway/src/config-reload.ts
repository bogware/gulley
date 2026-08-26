import {
  createDatabase,
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

  const db = createDatabase(config.DATABASE_URL);
  const store = new PostgresConfigStore(db);
  const versions = new PostgresConfigVersionStore(db);
  const resolver = buildSecretResolver(config);
  const reconciler = new GatewayReconciler(holder, store, resolver, log);

  const listen = createListenConnection(config.DATABASE_URL);
  // The reconnect hook references the watcher created just below; a const ref
  // object breaks the construction cycle without a reassigned `let`.
  const ref: { watcher?: ConfigWatcher } = {};
  const subscriber = new PostgresConfigBus(listen, config.CONFIG_NOTIFY_CHANNEL, () => {
    // Fires on every (re)connect — resync to catch anything missed while down.
    void ref.watcher?.resync();
  });
  ref.watcher = new ConfigWatcher(subscriber, reconciler, versions, newOriginId());
  return ref.watcher;
}
