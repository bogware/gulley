import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { registerConfigRoutes } from './config-routes';
import type { ControlContext } from './context';
import { registerAdminRoutes } from './routes';

export function buildServer(config: Config, ctx?: ControlContext): FastifyInstance {
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
  app.get('/ready', async (_req, reply) => {
    if (!ctx) {
      reply.code(503);
      return { status: 'degraded' };
    }
    return { status: 'ready' };
  });
  app.get('/', async () => ({ name: 'gulley-control-api', version: GULLEY_VERSION }));

  if (ctx) {
    registerAdminRoutes(app, ctx);
    registerConfigRoutes(app, ctx);
  }

  return app;
}
