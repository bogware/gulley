import { GULLEY_VERSION } from '@gulley/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { registerConfigRoutes } from './config-routes';
import type { ControlContext } from './context';
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

export function buildServer(config: Config, ctx?: ControlContext): FastifyInstance {
  const app = Fastify({
    // Trust a FIXED number of proxy hops (1 = the ALB), not every hop — `trustProxy:true`
    // lets a client spoof req.ip via X-Forwarded-For, defeating any IP-based control.
    trustProxy: config.CONTROL_API_TRUST_PROXY_HOPS,
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

  registerHttpEdge(app, config);

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
      return { status: 'degraded' };
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
