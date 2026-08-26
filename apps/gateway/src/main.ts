import { type MetricsServerHandle, startMetricsServer } from '@gulley/metrics';
import { closeUpstreamPool } from '@gulley/providers';
import { loadConfig } from './config';
import { buildConfigWatcher } from './config-reload';
import { createProductionContext } from './context';
import type { ConfigWatcher } from './reconcile';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const config = loadConfig();
let metricsServer: MetricsServerHandle | undefined;
let configWatcher: ConfigWatcher | undefined;

let context: GatewayContext | undefined;
try {
  context = createProductionContext(config);
} catch (err) {
  // Boot health-only so the container stays inspectable while config is finished.
  // The messages route is simply not registered until the context is complete.
  console.warn(`[gateway] proxy disabled — ${(err as Error).message}`);
}

const app = buildServer(config, context);

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
    if (context?.metrics) {
      metricsServer = await startMetricsServer({
        metrics: context.metrics,
        port: config.METRICS_PORT,
        host: config.METRICS_HOST,
      });
      app.log.info({ port: metricsServer.port }, 'metrics listener up on /metrics');
    }
    // M13: start the config-reload watcher after listen (loads DB config + subscribes).
    if (app.routeHolder) {
      configWatcher = buildConfigWatcher(config, app.routeHolder, {
        info: (msg) => app.log.info(msg),
        error: (err, msg) => app.log.error({ err }, msg),
      });
      if (configWatcher) {
        await configWatcher.start();
        app.log.info('config hot-reload watcher started (CONFIG_SOURCE=db)');
      }
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

// Safety net: a stray rejection (e.g. best-effort bookkeeping) must never
// terminate the process and cut in-flight streams.
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection');
});

// Bounded graceful drain: stop accepting, let in-flight streams finish, close
// the upstream pool. A backstop under Fargate's 120s stopTimeout guarantees we
// exit before SIGKILL; streams cut at the backstop reconnect via Last-Event-ID.
const SHUTDOWN_GRACE_MS = Number(process.env['SHUTDOWN_GRACE_MS']) || 110_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, 'draining');
  const backstop = setTimeout(() => {
    app.log.warn('drain grace elapsed, forcing exit');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  backstop.unref();
  try {
    await configWatcher?.stop(); // stop reloads before draining so none races the close
    await app.close();
    await context?.flushLogs?.(); // drain buffered request logs before exit
    await metricsServer?.close();
    await closeUpstreamPool();
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
  }
  clearTimeout(backstop);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

void start();
