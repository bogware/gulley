import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { type GatewayContext, registerRoutes, RouteHolder } from './routes/messages';

/** A built gateway server carries its RouteHolder so the config-reload watcher
 *  can swap the live route table. */
export type GatewayServer = FastifyInstance & { routeHolder?: RouteHolder };

export function buildServer(config: Config, context?: GatewayContext): GatewayServer {
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

  const holder = context ? new RouteHolder(context) : undefined;
  // /health = process liveness (always 200). /ready = 503 until a working
  // context is wired, so ALB/ECS pull a task that booted without providers/DB
  // out of service and the deployment circuit-breaker rolls it back. /ready
  // recomputes providers from the (swappable) holder so a reconcile is reflected.
  app.get('/health', async () => ({ status: 'ok', service: 'gateway', version: GULLEY_VERSION }));
  app.get('/ready', async (_req, reply) => {
    if (!holder) {
      reply.code(503);
      return { status: 'degraded' };
    }
    return { status: 'ready', providers: holder.providers() };
  });
  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  if (holder) registerRoutes(app, holder);

  const server = app as GatewayServer;
  server.routeHolder = holder;
  return server;
}
