import { closeUpstreamPool } from '@gulley/providers';
import { loadConfig } from './config';
import { createProductionContext } from './context';
import type { GatewayContext } from './routes/messages';
import { buildServer } from './server';

const config = loadConfig();

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
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

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
    await app.close();
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
