import { AlertDispatcher, isAlertProbe, makeAlert } from '@gulley/alerts';
import type { FastifyInstance } from 'fastify';
import { adminRoute, forbidden } from './admin';
import type { ControlContext } from './context';

/**
 * Alerting admin surface. `POST /admin/alerts/test` delivers one synthetic event to
 * EVERY configured channel right now (filters and storm control bypassed) and reports
 * per channel, so an operator proves a new channel end to end without waiting for a
 * real incident; owner-only (`config:apply`) and audited. `GET /admin/alerts/status`
 * lists the channels by label and type — never a URL or a key.
 */
export function registerAlertRoutes(app: FastifyInstance, ctx: ControlContext): void {
  app.get(
    '/admin/alerts/status',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      const sink = ctx.alerts;
      if (!(sink instanceof AlertDispatcher)) return reply.send({ enabled: false, channels: [] });
      return reply.send({ enabled: true, channels: sink.describe(), stats: sink.stats });
    }),
  );

  app.post(
    '/admin/alerts/test',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:apply', {}))) return forbidden(reply);
      const sink = ctx.alerts;
      if (!isAlertProbe(sink)) {
        return reply
          .code(501)
          .send({ error: { type: 'not_configured', message: 'ALERT_CHANNELS is not configured' } });
      }
      const event = makeAlert({
        kind: 'config.applied',
        version: 0,
        contentHash: 'alert-test',
        actor: admin.subject,
        summary: { test: true },
      });
      const channels = await sink.probe(event);
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'alerts.test',
        target: event.kind,
        payload: {
          channels: channels.map((c) => ({
            channel: c.channel,
            type: c.type,
            ok: c.ok,
            attempts: c.attempts,
          })),
        },
      });
      return reply.send({
        event: { kind: event.kind, at: event.at, severity: event.severity },
        channels,
      });
    }),
  );
}
