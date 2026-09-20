import { setAirGappedEgress } from '@gulley/egress';
import { type MetricsServerHandle, startMetricsServer } from '@gulley/metrics';
import { closeUpstreamPool } from '@gulley/providers';
import pino from 'pino';
import { loadConfig } from './config';
import { buildConfigWatcher } from './config-reload';
import { createProductionContext } from './context';
import type { ConfigWatcher } from './reconcile';
import type { GatewayContext } from './routes/messages';
import { buildServer, LOG_REDACT_PATHS } from './server';

const config = loadConfig();
// One structured logger for the whole process: context build (pool/Redis/maintenance
// warnings used to go to console.warn as unstructured text), Fastify request lines,
// and the drain — same level, same redaction.
const log = pino({ level: config.LOG_LEVEL, redact: { paths: LOG_REDACT_PATHS, remove: true } });
// Air-gapped posture is process-wide, set before any egress can happen: fail-closed on
// any guarded outbound without an explicit allowlist.
setAirGappedEgress(config.AIR_GAPPED);
let metricsServer: MetricsServerHandle | undefined;
let configWatcher: ConfigWatcher | undefined;

let context: GatewayContext | undefined;
let degradedReason: string | undefined;
try {
  context = createProductionContext(config, log);
} catch (err) {
  // Boot health-only so the container stays inspectable while config is finished.
  // The messages route is simply not registered until the context is complete. The
  // reason is kept and surfaced on /ready so an operator debugging a 503 sees it
  // without hunting for the boot line.
  degradedReason = (err as Error).message;
}

// Shared drain flag: /ready flips to 503 the instant a SIGTERM drain begins, so the pod
// deregisters from Service/ALB endpoints before app.close() (see server.ts /ready).
const drainState = { active: false };
const app = buildServer(config, context, {
  isDraining: () => drainState.active,
  degradedReason: () => degradedReason,
  logger: log,
});
if (degradedReason) app.log.warn({ reason: degradedReason }, 'proxy disabled — health-only boot');

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
// terminate the process and cut in-flight streams. Serialize under `err` so pino
// emits message + stack (an Error under any other key logs as `{}`).
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  app.log.error({ err }, 'unhandledRejection');
});

// Bounded graceful drain: stop accepting, let in-flight streams finish, close
// the upstream pool. A backstop under Fargate's 120s stopTimeout guarantees we
// exit before SIGKILL; streams cut at the backstop reconnect via Last-Event-ID.
const SHUTDOWN_GRACE_MS = config.SHUTDOWN_GRACE_MS;
// After an uncaughtException the process is in an UNDEFINED state, so we must not
// let in-flight streams keep running the full SIGTERM budget (they may compound the
// fault). Drain briefly to give the single teardown()s a chance to commit budget +
// write audit/ledger rows, then exit non-zero so the orchestrator restarts us.
const UNCAUGHT_GRACE_MS = Math.min(SHUTDOWN_GRACE_MS, 5_000);
let shuttingDown = false;

/** Run one drain step; a failure is logged and the remaining steps still run (a
 *  rejected app.close() must not skip the log/telemetry flushes behind it). */
async function settle(step: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    app.log.error({ err, step }, 'shutdown step failed');
  }
}

async function shutdown(signal: string, graceMs = SHUTDOWN_GRACE_MS, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  drainState.active = true; // /ready → 503 so endpoints deregister before app.close()
  context?.metrics?.setDegraded('draining');
  app.log.info({ signal, graceMs }, 'draining');
  // Two-stage backstop. Stage 1 (a few seconds before the deadline): sever every
  // connection still open — a long or stalled stream that outlives the grace period —
  // so each hijacked socket's 'close' path runs its single teardown() (budget commit +
  // ledger/audit rows) and app.close() can resolve, leaving the reserve for the sink
  // flushes below. Stage 2 (the deadline): exit regardless. Without stage 1 the old
  // single backstop exited with the streams' teardowns and every buffered sink
  // (request log, OTLP batches) unflushed.
  const flushReserveMs = Math.min(5_000, Math.max(1_000, Math.floor(graceMs / 4)));
  const sever = setTimeout(
    () => {
      app.log.warn({ flushReserveMs }, 'drain grace nearly elapsed — severing open connections');
      try {
        app.server.closeAllConnections();
      } catch (err) {
        app.log.error({ err }, 'closeAllConnections failed');
      }
    },
    Math.max(0, graceMs - flushReserveMs),
  );
  sever.unref();
  const backstop = setTimeout(() => {
    app.log.warn('drain grace elapsed, forcing exit');
    process.exit(exitCode);
  }, graceMs);
  backstop.unref();
  await settle('config-watcher', () => configWatcher?.stop()); // stop reloads before draining
  await settle('breaker-sync', () => context?.breakerSync?.stop()); // cross-replica refresh timer
  await settle('maintenance', () => context?.stopMaintenance?.()); // sweeps / retention timers
  await settle('http-close', () => app.close());
  // Drain the upstream pool BEFORE flushing the log sinks: closeUpstreamPool()
  // completes in-flight streams, and their single teardown writes the request/
  // access-log/audit rows — so flushing first would drop those late teardowns.
  await settle('upstream-pool', () => closeUpstreamPool());
  await settle('request-log', () => context?.flushLogs?.()); // buffered request logs
  await settle('access-log', () => context?.accessLogSink?.shutdown()); // OTLP access-log batch
  await settle('telemetry', () => context?.telemetry?.shutdown()); // OTel span pipeline
  await settle('metrics', () => metricsServer?.close());
  clearTimeout(sever);
  clearTimeout(backstop);
  app.log.info({ signal }, 'drained');
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// A synchronous throw that escapes an event-loop callback (a stream listener, a
// maintenance timer) would otherwise hit Node's default: an immediate exit that
// severs every hijacked SSE socket WITHOUT running its centralized teardown(), so
// reserved budget is never committed/refunded and no ledger/request-log/audit rows
// are written — the exact SOC 2 audit-completeness gap the design guards against.
// Route it through the SAME bounded drain (short grace) so teardowns get a chance
// to run, then exit non-zero for the orchestrator to restart.
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException — draining and exiting');
  void shutdown('uncaughtException', UNCAUGHT_GRACE_MS, 1);
});

void start();
