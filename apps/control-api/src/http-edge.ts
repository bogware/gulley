import {
  type CorsConfig,
  corsAllows,
  corsPreflightHeaders,
  corsResponseHeaders,
  csrfBlocked,
  isCorsPreflight,
} from '@gulley/http-edge';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config';
import { corsOrigins } from './config';

/**
 * Install the admin-surface HTTP edge: credentials-safe CORS + Sec-Fetch-Site
 * CSRF. Safe as global Fastify hooks here because the control plane never
 * hijacks the response (unlike the gateway data plane). No-ops entirely when
 * CORS has no origins and CSRF is disabled.
 */
export function registerHttpEdge(app: FastifyInstance, config: Config): void {
  const cors: CorsConfig = { origins: corsOrigins(config) };
  const csrfOn = config.ADMIN_CSRF_ENABLED;
  if (cors.origins.size === 0 && !csrfOn) return;

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers['origin'];
    const originStr = Array.isArray(origin) ? origin[0] : origin;

    // 1) CORS preflight — short-circuit an allowlisted OPTIONS with a 204.
    if (isCorsPreflight(request.method, originStr, cors)) {
      await reply.code(204).headers(corsPreflightHeaders(originStr, cors)).send();
      return reply;
    }

    // 2) CSRF — reject a cookie-authed cross-site unsafe request. An allowlisted
    // origin is CORS-vetted and exempt; bearer/API and non-browser clients too.
    if (csrfOn && !corsAllows(originStr, cors)) {
      const secFetchSite = request.headers['sec-fetch-site'];
      const site = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite;
      const hasAuthHeader = typeof request.headers['authorization'] === 'string';
      if (csrfBlocked({ method: request.method, secFetchSite: site, hasAuthHeader })) {
        await reply
          .code(403)
          .send({ error: { type: 'csrf', message: 'cross-site request rejected' } });
        return reply;
      }
    }
    return undefined;
  });

  if (cors.origins.size > 0) {
    app.addHook('onSend', async (request, reply, payload) => {
      const origin = request.headers['origin'];
      const originStr = Array.isArray(origin) ? origin[0] : origin;
      const headers = corsResponseHeaders(originStr, cors);
      for (const [k, v] of Object.entries(headers)) reply.header(k, v);
      return payload;
    });
  }
}
