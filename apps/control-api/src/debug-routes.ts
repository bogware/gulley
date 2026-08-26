import type { FastifyInstance } from 'fastify';
import { adminRoute, body, str } from './admin';
import type { Config } from './config';
import type { ControlContext } from './context';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** Keys whose VALUES must never appear in a diagnostic dump. */
const SENSITIVE_KEY = /SECRET|PEPPER|PASSWORD|CREDENTIAL|KEY|TOKEN/i;

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
      out[k] = typeof v === 'string' && v.length > 0 ? '<set>' : '<unset>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Admin DX: runtime log-level control (no redeploy) and a redacted config dump.
 * Both are admin-guarded; the dump never emits a secret value.
 */
export function registerDebugRoutes(
  app: FastifyInstance,
  ctx: ControlContext,
  config: Config,
): void {
  app.get(
    '/admin/log-level',
    adminRoute(ctx, async (_req, reply) => reply.send({ level: app.log.level })),
  );

  app.post(
    '/admin/log-level',
    adminRoute(ctx, async (request, reply) => {
      const level = str(body(request)['level']);
      if (!level || !LOG_LEVELS.includes(level as LogLevel)) {
        return reply.code(422).send({
          error: { type: 'validation', message: `level must be one of ${LOG_LEVELS.join(', ')}` },
        });
      }
      app.log.level = level;
      await ctx.audit.append({
        orgId: null,
        actor: 'admin',
        action: 'debug.log_level',
        target: level,
        payload: { level },
      });
      return reply.send({ level });
    }),
  );

  app.get(
    '/admin/config-dump',
    adminRoute(ctx, async (_req, reply) => reply.send({ config: redactConfig(config) })),
  );
}
