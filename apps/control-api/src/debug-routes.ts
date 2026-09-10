import type { FastifyInstance } from 'fastify';
import { adminRoute, auditedWrite, body, forbidden, str } from './admin';
import type { Config } from './config';
import type { ControlContext } from './context';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** Keys whose string VALUES must never appear in a diagnostic dump. Includes the
 *  Authorization-style shared tokens (AUTHZ / AUTHORIZATION / BEARER) and signing
 *  material (HMAC / SIGN) — e.g. AUDIT_ANCHOR_AUTHZ and SIEM_AUTHZ, which the older
 *  pattern missed and leaked verbatim. */
const SENSITIVE_KEY =
  /SECRET|PEPPER|PASSWORD|CREDENTIAL|KEY|TOKEN|AUTHZ|AUTHORIZATION|BEARER|HMAC|SIGN/i;

/** Strip userinfo (user:pass@) from a URL, keeping host/path for diagnostics. */
function stripUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * A safe view of the effective config: values of secret-bearing keys are reduced
 * to a set/unset marker and URL credentials are stripped, so an operator can
 * verify configuration without the dump ever leaking a secret (upholds
 * secret-ARNs-only / no-inline-secret).
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string' && /_URL$/i.test(k)) {
      out[k] = stripUrlCredentials(v);
    } else if (SENSITIVE_KEY.test(k)) {
      // Only a string can carry a secret; collapse it to a set/unset marker. Non-string
      // values (numbers/booleans that happen to match, e.g. a *_TIMEOUT_MS knob) are shown
      // as-is rather than mislabeled '<unset>'.
      out[k] = typeof v === 'string' ? (v.length > 0 ? '<set>' : '<unset>') : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Admin DX: runtime log-level control (no redeploy) and a redacted config dump.
 * The reads are gated on `config:read` (matching observability-routes) and the mutation
 * on `config:apply` — deny-by-default, not merely "any authenticated admin" — so a scoped
 * viewer can't recon the effective config or blind operators by silencing logs. The dump
 * never emits a secret value.
 */
export function registerDebugRoutes(
  app: FastifyInstance,
  ctx: ControlContext,
  config: Config,
): void {
  app.get(
    '/admin/log-level',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      return reply.send({ level: app.log.level });
    }),
  );

  app.post(
    '/admin/log-level',
    adminRoute(ctx, async (request, reply, admin) => {
      const level = str(body(request)['level']);
      if (!level || !LOG_LEVELS.includes(level as LogLevel)) {
        return reply.code(422).send({
          error: { type: 'validation', message: `level must be one of ${LOG_LEVELS.join(', ')}` },
        });
      }
      // Route through auditedWrite so the permission check + attributed, hash-chained audit
      // row can't drift apart: config:apply required, actor = admin.subject (not a hardcoded
      // 'admin' that destroyed attribution).
      const res = await auditedWrite(ctx, admin, {
        perm: 'config:apply',
        at: {},
        action: 'debug.log_level',
        target: level,
        diff: { level },
        mutate: () => {
          app.log.level = level;
        },
      });
      if (!res.ok) return forbidden(reply);
      return reply.send({ level });
    }),
  );

  app.get(
    '/admin/config-dump',
    adminRoute(ctx, async (_req, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:read', {}))) return forbidden(reply);
      return reply.send({ config: redactConfig(config) });
    }),
  );
}
