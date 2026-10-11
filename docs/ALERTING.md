# Alerting

Gulley delivers operational alerts — budget thresholds and rejections, virtual-key
expiry, circuit-breaker transitions, guardrail blocks, config applies, break-glass
elevations, runaway agent sessions — to **Slack**, **Microsoft Teams**, **PagerDuty**,
**email (SMTP)** and **HMAC-signed webhooks**. One package (`@gulley/alerts`) serves both
planes: the gateway emits the data-plane events, the control-api emits the control-plane
events and runs the key-expiry sweep. Delivery is fire-and-forget with retry, storm
control, a bounded queue and the same SSRF/air-gap egress guard as every other outbound.

## Configuration

`ALERT_CHANNELS` is **one JSON array** of channel objects, read by both the gateway and the
control-api (set it on both if you want both planes' events). Unset = alerts off (a no-op
sink). The value carries secrets (webhook URLs with embedded tokens, routing keys, the
SMTP password): hold it in the secret store and never put it in a YAML export.

```json
[
  {
    "type": "slack",
    "url": "https://hooks.slack.com/services/<id>",
    "events": ["budget.*", "breaker.*"]
  },
  {
    "type": "teams",
    "url": "https://<tenant>.webhook.office.com/webhookb2/<id>",
    "minSeverity": "warning"
  },
  {
    "type": "pagerduty",
    "routingKey": "<events-v2-integration-key>",
    "minSeverity": "critical",
    "severityMap": { "warning": "error" }
  },
  {
    "type": "webhook",
    "url": "https://ops.acme.example/gulley/alerts",
    "secret": "<shared-hmac-secret>"
  },
  {
    "type": "email",
    "smtpUrl": "smtps://alerts%40acme.example:<password>@smtp.acme.example:465",
    "from": "gulley@acme.example",
    "to": ["oncall@acme.example"],
    "events": ["key.*", "admin.*"]
  }
]
```

Every channel takes the common knobs:

| Field            | Meaning                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `events`         | Filter: `"*"`, a family (`"budget.*"`) or exact kinds. Unknown names are rejected at boot. Absent = all. |
| `minSeverity`    | `info` (default) / `warning` / `critical`: the lowest severity delivered.                                |
| `dedupeWindowMs` | Storm control window for this channel (default 60 000; PagerDuty defaults to 0, it dedupes natively).    |
| `name`           | Optional label used in logs, metrics and the test endpoint instead of `type` / `type#n`.                 |

Type-specific fields:

| Type        | Fields                               | Wire format                                                                                                                       |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `slack`     | `url` (incoming webhook)             | `text` fallback + Block Kit blocks (header, summary, fields, context).                                                            |
| `teams`     | `url` (Workflows / incoming webhook) | `{ type: "message", attachments: [ Adaptive Card 1.4 ] }` with a FactSet.                                                         |
| `pagerduty` | `routingKey`, `severityMap?`         | Events API v2 `trigger`; `dedup_key = <kind>:<entity>`; `breaker.closed` sends a `resolve` for the matching `breaker.open`.       |
| `webhook`   | `url`, `secret` (≥ 16 chars)         | JSON POST of the event, signed (below).                                                                                           |
| `email`     | `smtpUrl`, `from`, `to[]`            | Subject `[gulley] <kind>: <entity>`, plain-text body. `smtps://` = implicit TLS; `smtp://` requires STARTTLS outside development. |

Control-api only:

| Variable                                  | Default | Meaning                                                          |
| ----------------------------------------- | ------- | ---------------------------------------------------------------- |
| `ALERT_KEY_EXPIRY_DAYS`                   | `7`     | Announce enabled virtual keys that expire within this many days. |
| `ALERT_KEY_EXPIRY_SWEEP_INTERVAL_SECONDS` | `3600`  | Sweep cadence; `0` = off.                                        |

## Events

Every event carries `kind`, `at` (ISO-8601) and `severity`; the emitter sets the severity
and these are the defaults.

| Kind                | Default severity                           | Emitted by  | Fields                                                                                                                        | Entity (dedupe key)       |
| ------------------- | ------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `budget.threshold`  | warning                                    | gateway     | `scope`, `scopeKind`, `entity`, `window`, `threshold`, `usedMicroUsd`, `capMicroUsd`, `utilization`, `workspaceId?`, `orgId?` | `entity`                  |
| `budget.exceeded`   | critical                                   | gateway     | `scope`, `scopeKind`, `entity`, `window`, `usedMicroUsd`, `capMicroUsd`, `requestId`, `workspaceId?`, `orgId?`                | `entity`                  |
| `key.expiring`      | warning                                    | control-api | `keyId`, `displayName`, `workspaceId`, `expiresAt`, `daysLeft`                                                                | `keyId`                   |
| `key.expired`       | warning                                    | control-api | `keyId`, `displayName`, `workspaceId`, `expiresAt`                                                                            | `keyId`                   |
| `breaker.open`      | critical                                   | gateway     | `target`, `provider`                                                                                                          | `target`                  |
| `breaker.closed`    | info                                       | gateway     | `target`, `provider`                                                                                                          | `target`                  |
| `guardrail.blocked` | warning                                    | gateway     | `direction`, `surface`, `workspaceId`, `principalId`, `categories[]`, `reason?`                                               | `workspaceId/principalId` |
| `config.applied`    | info                                       | control-api | `version`, `contentHash`, `actor`, `summary?`                                                                                 | `v<version>`              |
| `admin.break_glass` | critical                                   | control-api | `actor`, `reason`, `expiresAt`                                                                                                | `actor`                   |
| `session.runaway`   | critical (`blocked`) / warning (`flagged`) | gateway     | `session`, `workspaceId`, `principalId?`, `costMicroUsd`, `baselineMicroUsd`, `orgP99MicroUsd`, `action`                      | `session`                 |

`scopeKind` is one of `workspace | org | key | user | team | project | model | attr`.

The key-expiry sweep also writes audit rows (`key.expiring_soon`, `key.expired`, actor
`system:key-expiry-sweep`), and the test endpoint writes `alerts.test`.

## Webhook signature verification

Each delivery carries:

```
x-gulley-event:     <kind>
x-gulley-delivery:  <uuid>            (stable across retries — dedupe on it)
x-gulley-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Verify by recomputing the HMAC over the **raw** request body (not a re-serialised
parse), comparing in constant time, and rejecting a stale `t` (default tolerance 300 s):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts['t']);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(parts['v1'] ?? '', 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
```

`@gulley/alerts` exports the same recipe as `verifyWebhookSignature(secret, header, body,
{ toleranceSeconds })` for TypeScript consumers. Retries re-sign with a fresh `t`; the body
and the delivery id do not change.

## Delivery semantics

- **Fire-and-forget.** `AlertSink.emit()` never throws and never awaits: the gateway
  calls it from the hot path, so delivery happens on a small worker pool (8 concurrent)
  off the caller's path.
- **Retry.** Up to 3 retries per delivery (4 attempts) with 250 ms / 1 s / 4 s backoff,
  jittered ×0.5–1.5, on network errors, timeouts, HTTP 429 and 5xx, and on SMTP 4xx
  replies. Any other 4xx (a revoked webhook, a bad routing key) and SMTP auth / envelope /
  5xx failures are permanent and are not retried. Each attempt has a 5 s deadline;
  redirects are never followed.
- **Storm control.** Per channel, an identical `(kind, entity)` within `dedupeWindowMs`
  (default 60 s) is dropped. PagerDuty's window defaults to 0 because its `dedup_key`
  already collapses repeats into one incident.
- **Bounded queue.** At most 1 000 deliveries (event × channel) queued or in flight;
  beyond that an event is dropped and counted rather than growing memory. Drops and
  dedupes surface through the dispatcher's `stats` and the `onDropped` hook; each finished
  delivery through `onDelivered(kind, channel, ok)`.
- **No secrets in logs.** Channels are referred to by label; error text is scrubbed of
  every configured URL, key and password.

## Egress rules

Alert targets are outbound calls like any other, so they obey the control-plane egress
guard **at boot** (a bad channel fails startup instead of failing silently later):

- With `OUTBOUND_HOST_ALLOWLIST` set, every target host (the Slack/Teams/webhook host,
  `events.pagerduty.com`, the SMTP host) must be on it.
- Under `AIR_GAPPED` an empty allowlist denies everything.
- `https` is required outside `NODE_ENV=development`; `smtps://` or STARTTLS is required
  for mail in the same way.
- Localhost, link-local/metadata and RFC1918 targets are refused, and the HTTP fetch is
  DNS-pinned so a hostname cannot rebind to an internal address between the boot-time
  check and the connect.

## Testing a channel

`POST /admin/alerts/test` (owner, `config:apply`) delivers one synthetic `config.applied`
event to **every** configured channel right now — filters and storm control bypassed — and
returns a per-channel result (`ok`, `attempts`, `filtered`, `error`), so a new channel is
proven end to end without waiting for an incident. `GET /admin/alerts/status` lists the
channels by label and type with the dispatcher counters; neither endpoint returns a URL
or a key.

## Key-expiry sweep

On every tick (control-api) the sweep lists enabled virtual keys whose `expires_at` is
within `ALERT_KEY_EXPIRY_DAYS`, emits `key.expiring` (+ audit `key.expiring_soon`) once
per key while it is in the window, then `key.expired` (+ audit `key.expired`) once it
lapses. In DB mode one replica per tick does the work (advisory lock
`MAINTENANCE_LOCK.keyExpiryAlert`).

**Limitation:** the "already announced" set is in-process. There is no bookkeeping table
in this version, so a control-api restart may repeat a notice for a key still inside the
window (a `key.expired` only within roughly two sweep intervals of the expiry), and a key
whose expiry is rotated is announced again. The dispatcher's storm control covers a quick
restart; a durable bookkeeping table is the follow-up.

## Metrics

Both apps count deliveries through the dispatcher's `onDelivered` hook; the gateway's
soft-threshold crossings also keep the existing `gulley_budget_alerts_total` metric. The
legacy `BUDGET_ALERT_WEBHOOK_URL` bare webhook still works but `ALERT_CHANNELS` supersedes
it.
