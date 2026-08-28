import { GULLEY_VERSION } from '@gulley/core';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { type GatewayContext, registerRoutes, RouteHolder } from './routes/messages';

/** A built gateway server carries its RouteHolder so the config-reload watcher
 *  can swap the live route table. */
export type GatewayServer = FastifyInstance & { routeHolder?: RouteHolder };

export function buildServer(config: Config, context?: GatewayContext): GatewayServer {
  const app = Fastify({
    trustProxy: true,
    // Fastify's default request id is a per-process counter (`req-1`, ...) that
    // resets on restart and repeats across tasks — NOT unique across a multi-task
    // fleet over one Postgres. requestId keys the ledger, request log, audit rows,
    // and the mask-vault (whose reversal record is an upsert + AAD component), so a
    // collision would cross-attribute or overwrite. Mint a globally-unique id.
    genReqId: () => `req_${randomUUID()}`,
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
    const providers = holder?.providers() ?? [];
    // Degraded until there is at least one route: no context, OR a DB-config
    // gateway whose reconcile hasn't loaded routes yet — so the LB pulls the task
    // and only routes traffic once the route table is populated.
    if (!holder || providers.length === 0) {
      reply.code(503);
      return { status: 'degraded', providers };
    }
    return { status: 'ready', providers };
  });
  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  if (holder) registerRoutes(app, holder);

  const server = app as GatewayServer;
  server.routeHolder = holder;
  return server;
}
