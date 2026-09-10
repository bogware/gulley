import { GULLEY_VERSION } from '@gulley/core';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { type GatewayContext, registerRoutes, RouteHolder } from './routes/messages';

/** A built gateway server carries its RouteHolder so the config-reload watcher
 *  can swap the live route table. */
export type GatewayServer = FastifyInstance & { routeHolder?: RouteHolder };

/** Parse the TRUST_PROXY knob into Fastify's `trustProxy` shape: a boolean, a hop
 *  count (numeric string), or a trusted CIDR / comma-separated list passed through
 *  verbatim. A bare "true" trusts every hop (request.ip is then spoofable via a
 *  forged X-Forwarded-For) — operators using a CEL source-IP rule set a hop count
 *  or CIDR instead. */
export function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim();
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^\d+$/.test(v)) return Number(v);
  return v; // CIDR or comma-separated list
}

export function buildServer(
  config: Config,
  context?: GatewayContext,
  opts?: { isDraining?: () => boolean },
): GatewayServer {
  const app = Fastify({
    // Cap the inbound body (Fastify defaults to 1 MiB, which 413s real coding-agent
    // requests). The custom application/json buffer parser respects this limit.
    bodyLimit: config.MAX_REQUEST_BYTES,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
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
    // Draining (SIGTERM received): report NOT ready immediately so the pod/task is pulled
    // from Service/ALB endpoints before app.close(), closing the deregistration-race
    // window. The preStop sleep is the reliable mechanism (probe removal lags by
    // periodSeconds x failureThreshold); this flip is its complement.
    if (opts?.isDraining?.()) {
      reply.code(503);
      return { status: 'draining' };
    }
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
