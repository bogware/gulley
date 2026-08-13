import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { type GatewayContext, registerRoutes } from './routes/messages';

export function buildServer(config: Config, context?: GatewayContext): FastifyInstance {
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

  // The proxy forwards raw bytes upstream, so capture the body verbatim rather
  // than letting Fastify parse it into an object.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const providers = context?.routes.map((r) => r.provider) ?? [];
  app.get('/health', async () => ({ status: 'ok', service: 'gateway', version: GULLEY_VERSION }));
  app.get('/ready', async () => ({
    status: context ? 'ready' : 'degraded',
    providers: [...new Set(providers)],
  }));
  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  if (context) registerRoutes(app, context);

  return app;
}
