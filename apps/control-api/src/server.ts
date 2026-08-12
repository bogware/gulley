import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers["api-key"]',
          'req.headers.cookie',
        ],
        remove: true,
      },
    },
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'control-api',
    version: GULLEY_VERSION,
  }));

  app.get('/ready', async () => ({ status: 'ready' }));

  app.get('/', async () => ({ name: 'gulley-control-api', version: GULLEY_VERSION }));

  return app;
}
