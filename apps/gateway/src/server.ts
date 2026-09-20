import { GULLEY_VERSION } from '@gulley/core';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
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

/** Header paths pino must never emit (credentials). Shared with main.ts's logger. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["api-key"]',
  'req.headers.cookie',
];

export function buildServer(
  config: Config,
  context?: GatewayContext,
  opts?: {
    isDraining?: () => boolean;
    /** Why the proxy is disabled (health-only boot), surfaced on /ready. */
    degradedReason?: () => string | undefined;
    /** The process logger (pino). When given, Fastify logs through it (one JSON
     *  stream for boot, maintenance and request lines); else a logger is built here. */
    logger?: FastifyBaseLogger;
  },
): GatewayServer {
  const app = Fastify({
    // Cap the inbound body (Fastify defaults to 1 MiB, which 413s real coding-agent
    // requests). The custom application/json buffer parser respects this limit.
    bodyLimit: config.MAX_REQUEST_BYTES,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // Keep idle keep-alive connections open LONGER than the load balancer does: if the
    // target closes first, the LB may reuse the half-closed socket and answer 502.
    keepAliveTimeout: config.HTTP_KEEPALIVE_TIMEOUT_MS,
    // Fastify's per-request "incoming request"/"request completed" pair is replaced by
    // ONE completion record per request (see the onResponse hook below and the
    // pipeline's access record): the pair logged two lines per liveness probe and,
    // for a hijacked proxied stream, an "incoming" with never a completion.
    disableRequestLogging: true,
    // Fastify's default request id is a per-process counter (`req-1`, ...) that
    // resets on restart and repeats across tasks — NOT unique across a multi-task
    // fleet over one Postgres. requestId keys the ledger, request log, audit rows,
    // and the mask-vault (whose reversal record is an upsert + AAD component), so a
    // collision would cross-attribute or overwrite. Mint a globally-unique id.
    genReqId: () => `req_${randomUUID()}`,
    ...(opts?.logger
      ? { loggerInstance: opts.logger }
      : {
          logger: {
            level: config.LOG_LEVEL,
            redact: { paths: LOG_REDACT_PATHS, remove: true },
          },
        }),
  });

  // Node closes a connection whose headers arrive slower than headersTimeout; keep it
  // above the keep-alive idle window so an idle-then-reused connection is never cut
  // mid-request (the classic ALB/Node 502 pairing).
  app.server.headersTimeout = config.HTTP_KEEPALIVE_TIMEOUT_MS + 1_000;

  // Every non-hijacked reply (denials, 5xx, health) carries the request id so a client
  // or operator can correlate it with the log/audit rows. Hijacked streams bypass
  // onSend and set the header themselves at writeHead.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (!reply.hasHeader('x-gulley-request-id')) reply.header('x-gulley-request-id', request.id);
    done(null, payload);
  });

  // One completion record for every NON-hijacked reply (a denial, a 404, a 5xx, a
  // health probe): proxied streams and cache hits are hijacked and emit their own
  // richer record from the pipeline. Probes are logged at debug so they stay out of
  // an info-level stream. Also shipped to the OTLP access-log sink when configured.
  app.addHook('onResponse', (request, reply, done) => {
    const path = (request.url.split('?')[0] ?? request.url) || '/';
    const probe = request.method === 'GET' && (path === '/health' || path === '/ready');
    const record = {
      event: 'http.complete',
      requestId: request.id,
      method: request.method,
      route: path,
      statusCode: reply.statusCode,
      status: reply.statusCode < 400 ? 'ok' : 'error',
      latencyMs: Math.round(reply.elapsedTime),
    };
    if (probe) request.log.debug(record, 'probe');
    else {
      request.log.info(record, 'access');
      context?.accessLogSink?.emit(record);
    }
    done();
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
      const reason =
        opts?.degradedReason?.() ??
        (!holder ? 'no gateway context (health-only boot)' : 'no routes loaded yet');
      return { status: 'degraded', reason, providers };
    }
    // DB mode: a schema behind this build (or never migrated) is not ready either.
    const schema = holder.ctx.schemaStatus ? await holder.ctx.schemaStatus() : undefined;
    if (schema && !schema.ok) {
      reply.code(503);
      return { status: 'degraded', reason: `database schema: ${schema.reason}`, providers, schema };
    }
    return { status: 'ready', providers, ...(schema ? { schema } : {}) };
  });
  app.get('/', async () => ({ name: 'gulley-gateway', version: GULLEY_VERSION }));

  if (holder) registerRoutes(app, holder);

  const server = app as GatewayServer;
  server.routeHolder = holder;
  return server;
}
