import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      // Credential hygiene is always-on: strip auth material before anything is
      // logged, independent of the (separate) no-content-logging toggle.
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
    service: 'gateway',
    version: GULLEY_VERSION,
  }));

  // Readiness is a stub until real dependency checks land (Redis/PG reachable,
  // tokenizer/NER/embedding models warm). It must never report ready early —
  // ALB should not route to a task whose heavy deps aren't loaded.
  app.get('/ready', async () => ({ status: 'ready' }));

  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  return app;
}
