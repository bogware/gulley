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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

void start();
