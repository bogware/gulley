import { GULLEY_VERSION } from '@gulley/core';
import { allTargets } from '@gulley/routing';
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

  const providers =
    context?.routes.flatMap((r) => allTargets(r.strategy).map((t) => t.provider)) ?? [];
  // /health = process liveness (always 200). /ready = 503 until a working
  // context is wired, so ALB/ECS pull a task that booted without providers/DB
  // out of service and the deployment circuit-breaker rolls it back.
  app.get('/health', async () => ({ status: 'ok', service: 'gateway', version: GULLEY_VERSION }));
  app.get('/ready', async (_req, reply) => {
    if (!context) {
      reply.code(503);
      return { status: 'degraded' };
    }
    return { status: 'ready', providers: [...new Set(providers)] };
  });
  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  if (context) registerRoutes(app, context);

  return app;
}
