import { loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig();
const app = buildServer(config);

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
    // Fast, clean drain so ECS deploys / AZ events don't sever streams.
    // Real connection-aware draining arrives with the streaming pipeline.
    void app.close().then(() => process.exit(0));
  });
}

void start();
