import { GULLEY_VERSION } from '@gulley/core';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { registerConfigRoutes } from './config-routes';
import { AuditUnavailableError, type ControlContext } from './context';
import { registerCryptoShredRoutes } from './crypto-shred-routes';
import { registerDebugRoutes } from './debug-routes';
import { registerEvalRolloutRoutes } from './eval-rollout-routes';
import { registerObservabilityRoutes } from './observability-routes';
import { registerParityRoutes } from './parity-routes';
import { registerOAuthAdminRoutes } from './oauth-admin-routes';
import { registerOAuthRoutes } from './oauth-routes';
import { registerHttpEdge } from './http-edge';
import { registerLogRoutes } from './log-routes';
import { registerMaskVaultRoutes } from './mask-vault-routes';
import { registerOidcRoutes } from './oidc-routes';
import { registerScimRoutes } from './scim';
import { registerAdminRoutes } from './routes';

/** In-memory per-IP sliding-window limiter for the unauthenticated auth surface. Bounds
 *  brute-force / flood volume without a dependency. Per-instance (a multi-task deployment
 *  limits per task); a Redis-backed bucket would be needed for strict cross-task limits. */
function makeAuthThrottle(maxPerWindow: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (ip: string, now: number): boolean => {
    if (buckets.size > 20_000)
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, b);
    }
    b.count += 1;
    return b.count <= maxPerWindow;
  };
}

// The unauthenticated OAuth/OIDC protocol surface — the highest-value brute-force target.
const AUTH_SURFACE = /^\/(oauth|auth)\//;

/** Header paths pino must never emit (credentials). Shared with main.ts's logger. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["api-key"]',
  'req.headers.cookie',
];

export function buildServer(
  config: Config,
  ctx?: ControlContext,
  logger?: FastifyBaseLogger,
): FastifyInstance {
  const app = Fastify({
    // Trust a FIXED number of proxy hops (1 = the ALB), not every hop — `trustProxy:true`
    // lets a client spoof req.ip via X-Forwarded-For, defeating any IP-based control.
    trustProxy: config.CONTROL_API_TRUST_PROXY_HOPS,
    // Explicit body cap: generous enough for a large GitOps config-apply document, but
    // bounded (Fastify defaults to 1 MB, which would reject a big-fleet apply).
    bodyLimit: config.CONTROL_API_BODY_LIMIT_BYTES,
    // Fleet-unique request ids (Fastify's default `req-N` counter repeats across
    // tasks/restarts); every admin log line and error body carries this id.
    genReqId: () => `req_${randomUUID()}`,
    // Outlive the load balancer's idle timeout so it never reuses a socket we closed.
    keepAliveTimeout: config.HTTP_KEEPALIVE_TIMEOUT_MS,
    // One process logger (pino) when main.ts provides it, so boot warnings and request
    // lines share a level + redaction; tests/smoke scripts get a built-in logger.
    ...(logger
      ? { loggerInstance: logger }
      : { logger: { level: config.LOG_LEVEL, redact: { paths: LOG_REDACT_PATHS, remove: true } } }),
  });

  app.server.headersTimeout = config.HTTP_KEEPALIVE_TIMEOUT_MS + 1_000;

  // Echo the request id on every reply so a client can quote it to an operator.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (!reply.hasHeader('x-gulley-request-id')) reply.header('x-gulley-request-id', request.id);
    done(null, payload);
  });

  // Uniform error bodies. Fastify's default handler echoes `error.message` for every
  // thrown error — a Postgres cast error, a driver's host:port, a stack-adjacent
  // detail — to the client. 5xx bodies are now generic (the detail goes to the log
  // with the request id); 4xx keep their message (body-parse/validation text is the
  // caller's own input). A lost audit row is its own, alertable shape.
  app.setErrorHandler((err, request, reply) => {
    const e = err as Error & { statusCode?: number; code?: string; validation?: unknown };
    if (e instanceof AuditUnavailableError) {
      request.log.error(
        {
          err: e.cause,
          event: 'audit_lost',
          action: e.event.action,
          target: e.event.target ?? null,
          actor: e.event.actor,
        },
        'audit append failed after the mutation ran — the change may be applied but unaudited',
      );
      return reply.code(500).send({
        error: {
          type: 'audit_unavailable',
          message: 'the change could not be audited and may have been applied',
          requestId: request.id,
        },
      });
    }
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: e, event: 'unhandled_error' }, 'request failed');
      return reply.code(status).send({
        error: { type: 'internal', message: 'internal error', requestId: request.id },
      });
    }
    request.log.info({ statusCode: status, code: e.code, reason: e.message }, 'request rejected');
    return reply.code(status).send({
      error: {
        type: e.validation ? 'validation' : 'bad_request',
        message: e.message,
        requestId: request.id,
      },
    });
  });

  registerHttpEdge(app, config);

  // RFC 6749 §4.1.3 / RFC 8628 §3.4: every standards-conformant OAuth client (and the
  // `gulley` CLI) sends token / device-authorization / revocation requests as
  // application/x-www-form-urlencoded. Parse it into the same plain object shape the
  // JSON routes read via body(), bounded by the server body limit.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Brute-force / flood guard on the unauthenticated OAuth/OIDC endpoints (token
  // exchange, device authorization, OIDC callback). Registered before the routes so it
  // sheds excess volume with a 429 + Retry-After before any handler runs.
  if (config.CONTROL_API_AUTH_RATE_LIMIT_PER_MIN > 0) {
    const throttle = makeAuthThrottle(config.CONTROL_API_AUTH_RATE_LIMIT_PER_MIN, 60_000);
    app.addHook('onRequest', (req, reply, done) => {
      const path = req.url.split('?')[0] ?? req.url;
      if (AUTH_SURFACE.test(path) && !throttle(req.ip, Date.now())) {
        void reply
          .code(429)
          .header('retry-after', '60')
          .send({ error: 'rate_limited', error_description: 'too many requests' });
        return; // do not call done() — the request is shed
      }
      done();
    });
  }

  app.get('/health', async () => ({
    status: 'ok',
    service: 'control-api',
    version: GULLEY_VERSION,
  }));
  app.get('/ready', async (_req, reply) => {
    if (!ctx) {
      reply.code(503);
      return { status: 'degraded', reason: 'no admin context (health-only boot)' };
    }
    // DB mode: not ready while the database schema is behind this build (or was never
    // migrated) — the failure mode was a healthy-looking boot that 500'd on first use.
    if (ctx.schemaStatus) {
      const schema = await ctx.schemaStatus();
      if (!schema.ok) {
        reply.code(503);
        return { status: 'degraded', reason: `database schema: ${schema.reason}`, schema };
      }
      return { status: 'ready', schema };
    }
    return { status: 'ready' };
  });
  app.get('/', async () => ({ name: 'gulley-control-api', version: GULLEY_VERSION }));

  if (ctx) {
    registerAdminRoutes(app, ctx);
    registerConfigRoutes(app, ctx);
    registerLogRoutes(app, ctx);
    registerMaskVaultRoutes(app, ctx);
    registerCryptoShredRoutes(app, ctx);
    registerEvalRolloutRoutes(app, ctx);
    registerObservabilityRoutes(app, ctx);
    registerParityRoutes(app, ctx);
    registerOAuthAdminRoutes(app, ctx);
    // Mount the broker's own /oauth/* protocol surface only when it is enabled.
    if (ctx.oauthBroker) registerOAuthRoutes(app, ctx.oauthBroker, ctx);
    registerOidcRoutes(app, ctx);
    registerScimRoutes(app, ctx);
    registerDebugRoutes(app, ctx, config);
  }

  return app;
}
