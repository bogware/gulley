import { loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig();
const app = buildServer(config);

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.CONTROL_API_HOST, port: config.CONTROL_API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection');
});

const SHUTDOWN_GRACE_MS = Number(process.env['SHUTDOWN_GRACE_MS']) || 110_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'draining');
  const backstop = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  backstop.unref();
  try {
    await app.close();
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
