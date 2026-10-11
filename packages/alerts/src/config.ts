import { z } from 'zod';
import { ALERT_KINDS, isAlertKind } from './types';

/**
 * `ALERT_CHANNELS` is one JSON array of channel objects. Every channel takes the
 * common filter knobs; the type-specific fields are the delivery target. Secrets
 * (webhook URLs with embedded tokens, routing keys, the SMTP password) live in this
 * value, so it belongs in the secret store — never in a YAML export or an audit row.
 */

const KIND_PREFIXES = new Set(ALERT_KINDS.map((k) => k.split('.')[0] as string));

/** `*`, `<family>.*` (e.g. `budget.*`) or an exact kind. Unknown kinds are rejected so
 *  a typo can't silently filter everything out. */
export function isValidEventPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return KIND_PREFIXES.has(pattern.slice(0, -2));
  return isAlertKind(pattern);
}

export function matchesEventPattern(
  kind: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(
    (p) => p === '*' || p === kind || (p.endsWith('.*') && kind.startsWith(p.slice(0, -1))),
  );
}

const eventPattern = z
  .string()
  .min(1)
  .refine(isValidEventPattern, (p) => ({
    message: `unknown event pattern "${p}" (use "*", "<family>.*" or one of ${ALERT_KINDS.join(', ')})`,
  }));

const common = {
  /** Optional label used in logs/metrics instead of `type#n`. */
  name: z.string().min(1).max(64).optional(),
  /** Event filter; absent = every kind. */
  events: z.array(eventPattern).max(64).optional(),
  /** Minimum severity delivered; absent = `info` (everything). */
  minSeverity: z.enum(['info', 'warning', 'critical']).optional(),
  /** Storm control: an identical (kind, entity) within this window is dropped for this
   *  channel. Default 60 000 ms (0 for PagerDuty, which dedupes by dedup_key). */
  dedupeWindowMs: z.number().int().min(0).max(86_400_000).optional(),
};

const url = z.string().url();

export const slackChannelSchema = z.object({ type: z.literal('slack'), url, ...common }).strict();
export const teamsChannelSchema = z.object({ type: z.literal('teams'), url, ...common }).strict();
export const pagerdutyChannelSchema = z
  .object({
    type: z.literal('pagerduty'),
    routingKey: z.string().min(16, 'routingKey looks too short to be an Events API v2 key'),
    /** Map Gulley severities onto PagerDuty's (`critical | error | warning | info`). */
    severityMap: z
      .object({
        info: z.enum(['critical', 'error', 'warning', 'info']).optional(),
        warning: z.enum(['critical', 'error', 'warning', 'info']).optional(),
        critical: z.enum(['critical', 'error', 'warning', 'info']).optional(),
      })
      .strict()
      .optional(),
    ...common,
  })
  .strict();
export const webhookChannelSchema = z
  .object({
    type: z.literal('webhook'),
    url,
    /** Shared HMAC secret for `x-gulley-signature`; at least 16 characters. */
    secret: z.string().min(16, 'secret must be at least 16 characters'),
    ...common,
  })
  .strict();
export const emailChannelSchema = z
  .object({
    type: z.literal('email'),
    /** `smtps://user:pass@host:465` (implicit TLS) or `smtp://user:pass@host:587` (STARTTLS). */
    smtpUrl: z.string().min(1),
    from: z.string().min(3),
    to: z.array(z.string().min(3)).min(1).max(32),
    ...common,
  })
  .strict();

export const alertChannelSchema = z.discriminatedUnion('type', [
  slackChannelSchema,
  teamsChannelSchema,
  pagerdutyChannelSchema,
  webhookChannelSchema,
  emailChannelSchema,
]);

export const alertChannelsSchema = z.array(alertChannelSchema).max(32);

export type SlackChannelConfig = z.infer<typeof slackChannelSchema>;
export type TeamsChannelConfig = z.infer<typeof teamsChannelSchema>;
export type PagerDutyChannelConfig = z.infer<typeof pagerdutyChannelSchema>;
export type WebhookChannelConfig = z.infer<typeof webhookChannelSchema>;
export type EmailChannelConfig = z.infer<typeof emailChannelSchema>;
export type AlertChannelConfig = z.infer<typeof alertChannelSchema>;
export type AlertChannelType = AlertChannelConfig['type'];

/**
 * Parse the `ALERT_CHANNELS` JSON. Throws an Error whose message names every problem
 * by path (never echoing field values — a bad channel may still carry a real token),
 * so a misconfiguration fails boot with a readable reason.
 */
export function parseAlertChannels(json: string): AlertChannelConfig[] {
  const trimmed = json.trim();
  if (trimmed === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`ALERT_CHANNELS is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = alertChannelsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? `[${i.path.join('.')}]` : '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`ALERT_CHANNELS invalid: ${issues}`);
  }
  return parsed.data;
}
