import type { FastifyInstance } from 'fastify';

import { adminRoute, forbidden } from './admin';
import type { ControlContext } from './context';

/**
 * Live gateway observability. The gateway's Prometheus /metrics lives on a separate
 * management listener the browser can't reach through the /control proxy, so these
 * routes have the control-api fetch + parse + summarize it. Gated on `config:read`
 * (deployment-wide operational state — held by viewer and up; NOT workspace-scoped,
 * because the metrics are fleet-global with no workspace dimension). 501 when
 * GATEWAY_METRICS_URL is unset; 502 when the gateway listener is unreachable.
 */
export function registerObservabilityRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const notConfigured = {
    error: {
      type: 'not_configured',
      message: 'gateway metrics not enabled (set GATEWAY_METRICS_URL)',
    },
  };

  app.get(
    '/admin/observability/metrics',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      const provider = ctx.gatewayMetrics;
      if (!provider) return reply.code(501).send(notConfigured);
      try {
        return reply.send({ metrics: await provider.summary(new Date().toISOString()) });
      } catch (e) {
        return reply.code(502).send({
          error: { type: 'upstream', message: e instanceof Error ? e.message : String(e) },
        });
      }
    }),
  );

  app.get(
    '/admin/observability/metrics/raw',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      const provider = ctx.gatewayMetrics;
      if (!provider) return reply.code(501).send(notConfigured);
      try {
        return reply.type('text/plain; version=0.0.4; charset=utf-8').send(await provider.raw());
      } catch (e) {
        return reply.code(502).send({
          error: { type: 'upstream', message: e instanceof Error ? e.message : String(e) },
        });
      }
    }),
  );

  app.get(
    '/admin/observability/status',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      const provider = ctx.gatewayMetrics;
      if (!provider) return reply.send({ configured: false });
      return reply.send({ configured: true, ...(await provider.status(new Date().toISOString())) });
    }),
  );
}
