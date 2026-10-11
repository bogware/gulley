# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] — 2026-10-11

Wave 2 of the October 2026 cycle — **money and identity**: every dollar an agent spends
is capped by the right entity, and every identity that spends is a first-class
principal. Hierarchical hard budgets with calendar windows and a typed rejection,
workload identity federation for Kubernetes and GitHub Actions, per-agent FinOps with a
FOCUS export and a runaway-session kill switch, operator alert channels, and SAML SSO
with custom roles.

### Upgrade notes

- **Four migrations** (`0027_hierarchical_budgets`, `0028_custom_roles`,
  `0029_finops_sessions`, `0030_workload_federation`) — apply them before rolling the
  images (`/ready` is 503 on a schema that is behind). Existing `budget` rows become
  `scope_kind = 'workspace'` rows with `scope_id` backfilled from the workspace id;
  their config documents export exactly as before. The `role` table is seeded with the
  five built-in roles (`builtin = true`, never redefinable from a row).
- **The budget rejection is `402 quota_for_entity_exceeded`** (was `budget_exceeded`);
  see _Changed_. Clients matching on the old type string need updating.
- **`BUDGET_ALERT_THRESHOLDS` defaults to `0.5,0.75,1`** (was `0.8,0.9`) and alerts
  are keyed by budget scope; the legacy webhook payload gained `scope` / `scopeKind` /
  `entity` / `window`.
- **`BUDGET_SCOPES` defaults to the whole hierarchy** (`org,key,user,team,project`):
  each kind is one memoized cap lookup per request on the Redis path and a no-op when
  no row exists. `BUDGET_SCOPES=workspace` restores the 0.6 workspace-only check.
- **`x-user-id` is now honoured** — only from a federated service principal whose
  federation sets `onBehalfOf` — as the `user` attribution and budget scope. Every
  other principal ignores the header, as before.
- **New production dependencies** in the image: `nodemailer` (email alerts) and
  `@node-saml/node-saml` (SAML SP). Both are external in the bundle and land via the
  control-api `pnpm deploy` step; see `docs/SUPPLY_CHAIN.md`.
- **`ALERT_CHANNELS`** takes the same JSON on both apps: the gateway emits budget,
  guardrail-block and breaker events, the control API the rest. Under `AIR_GAPPED`
  no channel may point outside the allowlist.
- Helm chart `0.4.0` (`appVersion` `v0.7.0`).

### Added

- **Hierarchical hard budgets (K4).** A request must now be admitted by every budget in
  the hierarchy that carries a cap — **workspace → org → key → user → team → project**
  (`BUDGET_SCOPES`, default all) — before the per-model and per-attribution caps. A
  `budget` entity caps one entity (`scope: { kind, id }`) or, with `scope.id` omitted,
  every entity of that kind without its own row (the **default**: "$10/day per key"
  without naming a key); an org budget caps all of its workspaces together
  (`PUT /orgs/:id/budget`, DB mode). A budget is one or more **windows** that must all
  admit — `{ windows: [{ capMicroUsd, period: daily | weekly | monthly | none |
  { seconds } }] }`, calendar windows aligned to UTC midnight / Monday / the 1st with a
  counter per window — and the legacy `{ capMicroUsd, periodSeconds }` shape still
  works unchanged. The `user` scope is the end user the credential is bound to (a
  brokered grant, an IdP JWT) or the `x-user-id` a federated service principal is
  allowed to assert (K7); the `team` scopes are the principal's groups; the `project`
  scope is the `project` attribution. A rejection releases every reservation the
  request took and is a **typed `402`**: `error.type = quota_for_entity_exceeded`, a
  message that names the entity, current spend, limit, window and what the request
  needed, `error.scope` / `error.window` / `*_micro_usd` fields, `retry-after` until a
  calendar window resets and `x-should-retry: false`. The boot-time counter heal, the
  config document round-trip, the console Budgets page and the control-API validation
  (`422` with the problem) understand the new shape; `gulley_budget_rejections_total`
  counts rejections by scope kind. Migration `0027_hierarchical_budgets`.

- **Agent and service identities — workload identity federation (K7).** A Kubernetes
  service-account token or a GitHub Actions OIDC token is exchanged at the control
  plane (`POST /oauth/token`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`,
  RFC 7523) for a short-lived, **scoped, access-only** `gko_at_` token bound to the
  service principal `svc:<federation>:<sub>` — no static key, no human consent, no
  refresh token. Trust is configured per issuer in `WORKLOAD_FEDERATIONS` (zod-validated
  at boot: issuer, optional `jwksUri` / `audience` / `allowInternal`, a `:`-segmented
  subject glob and/or exact claim matches, org/workspace, provider/model/group scope,
  TTL ≤ 24 h, `onBehalfOf`). Verification is asymmetric-only with `iss`/`aud`/`exp`/
  `nbf`, a required `iat` no older than 10 minutes and a bounded per-process `jti`
  replay guard; every failure is one generic `invalid_grant`, every success an
  `oauth.token_exchanged` audit row. `@gulley/oidc` gained lenient discovery
  (`fetchJwksUriFromDiscovery`) and a jwks-only `OidcProvider` mode for issuers that
  publish no OIDC endpoints. The grant store carries `kind` / `federation` / `subject`
  / `scope` / `on_behalf_of` (migration `0030_workload_federation`), `/oauth/introspect`
  reports them, the RFC 8414 metadata advertises the grant type when configured, and
  the token exchange has its own per-IP budget
  (`CONTROL_API_TOKEN_EXCHANGE_RATE_LIMIT_PER_MIN`, default 600) so a NAT'd cluster
  never starves human logins. **End-user propagation:** `Principal` gained `userId`
  (set for brokered user grants and inbound IdP JWTs), `serviceAccount` and
  `onBehalfOf` (service principals), so the gateway can honour `x-user-id` only from a
  federation that permits it. Also: `gulley token exchange --k8s-sa | --github |
--assertion-file` (prints the token or an `export ANTHROPIC_AUTH_TOKEN=` line, never
  the assertion), expired token families are swept with the OAuth ephemera
  (`purgeExpiredGrants`, advisory lock `5138008707`), and a SCIM deprovision now revokes
  the user's broker grants as well as their sessions. `docs/WORKLOAD_IDENTITY.md`.

- **Alert channels (P9).** A new `@gulley/alerts` package delivers operational alerts to
  Slack, Microsoft Teams, PagerDuty (Events API v2, `dedup_key` per kind + entity,
  `breaker.closed` resolves), email (SMTP via `nodemailer`) and HMAC-signed generic
  webhooks (`x-gulley-signature: t=…,v1=…`, verifier exported), configured by one JSON
  `ALERT_CHANNELS` value on either plane with per-channel event/severity filters. Delivery
  is fire-and-forget off the hot path with 3 jittered retries on network / 429 / 5xx,
  per-channel storm control, a bounded in-flight queue and the boot-time egress guard
  (allowlist, https outside development, `AIR_GAPPED`). The control-api emits
  `config.applied` and `admin.break_glass`, runs a key-expiry sweep
  (`ALERT_KEY_EXPIRY_DAYS`, `ALERT_KEY_EXPIRY_SWEEP_INTERVAL_SECONDS`; `key.expiring` /
  `key.expired` plus audit rows `key.expiring_soon` / `key.expired`, one replica per tick)
  and serves `POST /admin/alerts/test` + `GET /admin/alerts/status`; the gateway's
  `BudgetAlerter` now emits `budget.threshold` through the same sink. See
  `docs/ALERTING.md`.

- **Per-agent FinOps (K5).** `GET /admin/analytics/agent-tree` rolls the durable ledger
  up by session → prompt → subagent (nested by `cc_parent_agent`), with the share spent
  on context compaction and on subagents; cascade / hedge / classifier legs
  (`<id>#<leg>`) are attributed to their parent request. The console's FinOps page
  gains an **Agent tree** tab. Migration `0029` adds the `spend_ledger_session_idx`
  expression index.
- **FOCUS 1.2 export.** `GET /admin/analytics/focus?from&to&format=csv|jsonl` streams
  every ledger row as a FinOps-Foundation FOCUS record (fixed column order, `x_gulley_*`
  extension columns, RFC 4180 CSV with formula-injection escaping, or JSON Lines) in
  50k-row pages continued through the `x-next-cursor` header. **FOCUS export** button
  on the console's Chargeback tab. See `docs/FINOPS.md`.
- **Runaway-session detector + session kill switch.** A control-api job
  (`RUNAWAY_DETECTOR_INTERVAL_SECONDS`, default 300) scores every session active in the
  last `RUNAWAY_WINDOW_MINUTES` against `2 × p95` of its principal's per-session spend
  over `RUNAWAY_BASELINE_DAYS` (the scope-wide p95 for a thin principal) and the
  scope-wide p99; a session above `max(RUNAWAY_MIN_COST_USD, baseline)` and above the
  p99 is audited `session.runaway` and alerted (`session.runaway`), and — with
  `RUNAWAY_ACTION=block` — written to the new `session_block` table (TTL
  `RUNAWAY_BLOCK_TTL_MINUTES`). `GET /admin/sessions/blocked`,
  `POST /admin/sessions/:session/block` and `DELETE …/block` (permission
  `key:disable`, audited `session.blocked` / `session.unblocked`) manage blocks; the
  console's **Runaway sessions** tab lists, unblocks and places them. `@gulley/storage`
  ships `SessionBlockSnapshot` + `loadActiveSessionBlocks` for the gateway's
  synchronous 403 `session_blocked` check.

### Changed

- **The budget rejection is `402 quota_for_entity_exceeded`** (was `budget_exceeded`),
  with the entity, window and amounts in the body and `retry-after` for a calendar
  window. Clients that matched on the old type string need the new one; the status
  code is unchanged.
- **`BUDGET_ALERT_THRESHOLDS` defaults to `0.5,0.75,1`** (was `0.8,0.9`): alerts are
  per budget scope and per window, and the hard rejection itself is always reported
  as the `1` level (`budget.exceeded` on the alert channels). The legacy
  `BUDGET_ALERT_WEBHOOK_URL` payload gained `scope`, `scopeKind`, `entity` and
  `window`; `workspaceId` is still present for workspace-partitioned scopes.

## [0.6.0] — 2026-10-11

Wave 1 of the October 2026 cycle — **agent trust**: the changes that make Gulley safe
to put in front of Claude Code and Codex on the Claude 5.5 generation and provable as
such. Conversation-stable masking (the per-request mask token that broke preserved
thinking and prompt caching is gone), signed reasoning pins the model, the Claude Code
gateway contract is executed as a published conformance report, zero-config agent
attribution, a live pricing catalog with `/v1/models` pricing, request-level routing
preferences with per-attempt provenance, and route groups as first-class DB config.

### Upgrade notes

- **`METER_FAIL_CLOSED_ON_UNPRICED` now defaults to `true`:** a served model with no
  price in the catalog or the seeds is charged its worst-case reservation instead of
  metering $0. Models of a `local` custom provider (Ollama, vLLM, …) are free and are
  never charged. Set it to `false` to restore the 0.5 behaviour.
- **`onStatusCodes` on a route group may list only 408, 409, 429 or a 5xx** (env
  `ROUTE_GROUPS` and DB route groups alike); a configured terminal 4xx is now rejected
  by validation and ignored by the failover check, so one bad request can never record
  a breaker fault or eject a healthy upstream.
- **Sonnet 5.5 cache reads are billed at 0.05× base ($0.10/MTok)**, matching Anthropic's
  list price; the 0.5.1 seed billed 0.1×. A drift test now holds the bundled snapshot
  and the seed tables to the same prices.
- The bundled models.dev snapshot becomes the default pricing catalog; prices for
  Claude on Bedrock and Vertex now come from the catalog (partner list prices) rather
  than the Anthropic seed table. Pin `MODELS_CATALOG_FILE` or `PRICING_OVERRIDES` for
  contracted rates.
- **Console `routes` entities change shape.** Entities written by the previous Routes
  page (`{ strategy | mode, targets[] }`, no `clientPath`) were never applied by the
  gateway; they still export/apply unchanged but are now listed as "legacy (ignored by
  the gateway)" and logged once per reconcile. Convert each in place on the Route groups
  page (fill in the client path and two or more providers) or delete it. New writes must
  be the route-group shape; `ROUTE_GROUPS` env entries are unchanged.

### Added

- **Route groups are first-class in DB-config mode.** A config document's `routes`
  entity is now a route group — the same shape as an env `ROUTE_GROUPS` entry
  (`clientPath`, `mode`, `providers`, `select`, `weights`, `onStatusCodes`,
  `hedgeDelayMs`, `modelMap`; the entity `name` is the group name; schema
  `routeGroupSchema` in `@gulley/routing`). The gateway folds document groups on every
  reconcile after the env overlay, so a DB group shadows an env group on the same client
  path (the `routes` collection used to be stored and never read). GitOps plan/apply and
  the console's `POST`/`PUT /routes` reject a malformed group (400 with the schema
  `issues`). The console's Route groups page lists, creates, edits and deletes them.

- **Conversation-stable reversible masking (K2).** Guardrail `mask` tokens are now
  derived by HMAC under a per-workspace × per-conversation key, so the same value masks
  to the same `<<GULLEY_EMAIL_<24 hex>>>` on every turn, in every replica and in both
  directions. The masked request prefix is byte-identical turn after turn, which keeps
  the provider's prompt cache hitting and passes the Claude 5.5-generation
  preserved-thinking prefix check; the previous per-request random token broke both
  (every masked multi-turn conversation on Opus 5.5 / Sonnet 5.5 / Fable 5.1 was
  rejected with "bound to a different conversation" and missed its cache prefix). The
  conversation is identified by `x-gulley-conversation-id` or Claude Code's
  `x-claude-code-session-id`, else a fingerprint of the system prompt + first user turn,
  else the virtual key. A token echoed back in the history is never re-masked. Persisted
  vault records carry the conversation id (migration `0026`) and the control plane can
  reveal a whole conversation: `GET /admin/mask-vault/conversation/:conversationId`.

- **Signed reasoning pins the model** (`SIGNED_THINKING_SUBSTITUTION`, default `pin`).
  A request whose history carries Anthropic `thinking` signatures / `redacted_thinking`
  or OpenAI Responses `reasoning.encrypted_content` keeps its requested model: the
  budget downshift, the cascade escalation and the smart re-route are skipped for it and
  audited as `policy.substitution_pinned`. Substituting the model made the API drop that
  reasoning silently and restarted the prompt cache. Set `allow` to substitute anyway.

- **Certified gateway-contract conformance (K6).** A black-box suite executes the rules
  of Anthropic's Claude Code gateway compatibility guide (open-list beta forwarding, no
  buffering, ping relay and Bedrock ping synthesis, event order, verbatim error bodies
  with `retry-after` / `x-should-retry` / `anthropic-ratelimit-unified-*`, model
  discovery timing, `count_tokens`, an unchanged `system` array and body fields,
  `capability_rejected:` tokens, consumed attribution headers) and OpenAI's Codex
  checklist (incremental Responses SSE through `response.completed`,
  `function_call_output` pairing, distinct error classes, model routing) against the
  assembled gateway on every CI run, and renders the committed per-release report
  `docs/CONFORMANCE.md` (`pnpm --filter @gulley/gateway conformance:report`; CI fails
  on drift; attached to each GitHub Release).
- **Request-level routing preferences and per-attempt provenance (P7).** An
  OpenRouter-compatible `provider` object (`order`, `only`, `ignore`, `allow_fallbacks`,
  `sort`, `zdr`, `max_price`) or Vercel's `providerOptions.gateway` (`order`, `only`,
  `sort`) in the request narrows or re-orders the route's candidates after scope, model
  policy, residency and the breaker have applied; an unsatisfiable preference is a 404.
  The fields are stripped before the cache key and the upstream see the body
  (`CLIENT_ROUTING_PREFERENCES`). Every response carries `x-gulley-attempts`
  (`<target>:<outcome>[:<status>][:<ms>]`) and a request that touched more than one
  attempt records it as the request-log `attempts` attribute.
- **Live pricing catalog (P8).** A models.dev snapshot ships in the image
  (`packages/catalog/data`, refreshed by a manual script) and is the default catalog;
  `MODELS_CATALOG_FILE` accepts the raw models.dev `api.json` as well as the entry-array
  format and can be reloaded in place when it changes (`PRICING_RELOAD_INTERVAL_SECONDS`);
  catalog long-context tiers, cache multipliers, context windows and output limits are
  honoured; contracted rates layer over everything (`PRICING_OVERRIDES[_FILE]`);
  `GET /v1/models` lists every priced model of a configured provider with per-token
  pricing, context window and max output in Anthropic's list shape; unpriced requests
  carry the `gulley.pricing.unpriced` span attribute.
- **Zero-config agent attribution** (`AGENT_HEADER_ATTRIBUTION`, default on). Claude
  Code's `x-claude-code-*` headers (session, subagent, parent agent, prompt, request
  class, agent type, compaction) and Codex's `originator` become attribution tags —
  `session`, `cc_agent`, `cc_parent_agent`, `prompt`, `request_class`, `agent_type`,
  `compaction`, `context_compacted` and `agent` (`claude-code` | `codex`) — on every
  ledger, request-log and audit row, so chargeback by session / prompt / subagent /
  agent product and per-attribution caps work without any `ATTRIBUTION_HEADERS`.
- **Claude Code gateway-contract fixes.** `POST /v1/messages/count_tokens` (also under
  `/anthropic` and `/bedrock`) is served through the same authn / scope / policy /
  residency / input-guardrail gates as inference, with no spend, via the adapter's
  `countTokens` (Anthropic passthrough; Bedrock `CountTokens`). The Bedrock translation
  synthesizes `ping` events during pauses (`BEDROCK_PING_INTERVAL_MS`, default 15 s)
  so Claude Code's streaming idle watchdog survives a long thinking pause, forwards the
  client's `anthropic-beta` header as the body's `anthropic_beta` list (an open list;
  `BEDROCK_BETA_DENY` strips values a region rejects), and reshapes Bedrock errors —
  HTTP and mid-stream — into Anthropic's envelope with the status kept, the message
  verbatim and `capability_rejected: prompt_too_long` for a prompt that does not fit.
  Gateway-generated errors carry `x-should-retry` (`true` for 429/502/503/504, `false`
  for other 4xx) and the 404 type is Anthropic's `not_found_error`. `GET /v1/models` is
  also served under `/anthropic` and `/bedrock`.

### Changed

- **The spotlight directive is appended, not prepended, and on every request**
  (`GUARDRAILS_SPOTLIGHT_DIRECTIVE`): it follows the client's own system content so a
  Claude Code attribution block stays first (Anthropic's strip is positional) and the
  system prompt is identical turn after turn (prompt cache + preserved thinking). It
  used to be prepended only on turns that carried a tool result, which changed the
  system prompt mid-conversation. OpenAI-shaped bodies get it on their leading system
  message instead of an invalid top-level `system` field.
- **Load-balancer session affinity defaults to the conversation identity** (the session
  header or the prefix fingerprint) when `LB_SESSION_AFFINITY_HEADER` is unset, so a
  multi-turn conversation stays on one provider — thinking signatures and prompt caches
  are provider-bound. Single-turn / unparseable requests keep the least-load spread.
- Mask token format: keyed tokens have no per-request counter
  (`<<GULLEY_EMAIL_<24 hex>>>`); the keyless library form keeps `_<nonce>_<n>`.

## [0.5.1] — 2026-10-10

A correctness patch from the October 2026 audit: eight HIGH defects (one a regression
from 0.5.0) in the data plane, the MEDIUM tail behind them, per-key scoping that the
schema could not hold, and four console DTO mismatches. Every fix ships with regression
tests; the data-plane changes went through the adversarial hot-path review.

### Upgrade notes

- **Run migration `0025`** (`node dist/control-api/migrate.mjs`): it adds the additive
  `allowed_providers` / `allowed_models` columns to `virtual_key`. Existing keys stay
  unrestricted.
- **Pricing seeds are refreshed to October 2026**, so chargeback and budget figures
  change: Claude Sonnet 5 was seeded at $3/$15 against its $2/$10 list price (reports
  were a third too high); Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 and Mythos 5.1
  were absent and **metered $0 — budgets never consumed for the default model**; OpenAI
  cached input is 0.1× on the GPT-5.x generation (older families keep their own
  multiplier) and the GPT-5.x, o-series and `text-embedding-*` models are priced
  (embeddings metered $0). Per-model cache-read multipliers (Opus 5.5 0.05×, Fable 5.1
  0.025×) and long-context tiers (Haiku 5.5 above 100K, GPT-5.x above 272K) apply —
  under a `MODELS_CATALOG_FILE` override the tier is scaled to the catalog's base
  price, so a negotiated Bedrock/Azure rate keeps governing above the threshold.
- **`METER_UNPRICED_CONFIG`** (new, default `fail`): `/ready` reports 503 while an
  operator-configured model (a model-alias target, `BUDGET_DOWNSHIFT_MODEL`, a cascade
  escalation target, a `ROUTE_GROUPS` model map entry) has no price in the seed or the
  catalog, since it would meter $0 on every request. Set `warn` to stay ready and list
  them; local-runtime presets are exempt; `gulley doctor` runs the same check.
- **Cache entries are now partitioned by delivery mode** (`stream`) and by
  `anthropic-version`. Entries written by 0.5.0 are not reused (they expire within
  `CACHE_TTL_SECONDS`).
- **`TOOL_POLICY` governs only requests that declare `tools` or a `tool_choice`.** Every
  other request streams unbuffered again. **Behavior change** — 0.5.0 buffered every
  response deployment-wide once a tool policy was set.
- **`STREAM_WATCHDOG_BREAKER_THRESHOLD`** (new, default `3`): an inactivity-watchdog abort
  faults the circuit breaker only after that many consecutive aborts on one target; set
  `1` for the 0.5.0 behavior.
- **Bedrock answers `stream:false` with JSON** through `invoke` (0.5.0 always returned SSE).
- **DB-config mode re-applies `CUSTOM_PROVIDERS` and `ROUTE_GROUPS` on every reconcile.**
  Deployments that saw those routes vanish after the first reconcile get them back.

### Security

- **The budget commit idempotency token no longer grows without bound (regression from
  0.5.0).** The committed-ids SET had its TTL re-stamped on every commit, so under steady
  traffic it never expired and grew by one member per request on the noeviction counters
  Redis until the store refused writes — at which point `BUDGET_FAIL_OPEN` (the default)
  admitted every request with no reservation. The token is now one self-expiring key per
  request (`SET NX EX`); verified against a live Redis over 5,000 commits.
- **A budget downshift can no longer leave the key's model scope.** The downshift
  reassigned the model after the authz gate without checking the key's own allow-list,
  so a compliance pin to one model could be undone by the cap.
- **Tool-call governance reads every chat choice and every OpenAI Responses `*_call`
  item.** A tool call on a second choice (`n>1`), a `local_shell_call`,
  `custom_tool_call`, `computer_call` or `mcp_call`, and the legacy `function_call` were
  invisible to the policy, so an allow-list passed them as "no tool calls".
- **A cached streamed response is never replayed to a non-streaming caller** (or the
  reverse); the exact key stripped `stream` while the hit path returned the stored bytes
  verbatim.
- **The default model is priced again** (see upgrade notes): an unpriced flagship model
  reserved at the floor but committed $0, so workspace, model and attribution caps never
  consumed.

### Fixed

- **DB-config mode kept its env-only routing.** The first reconcile replaced the route
  table with the document's provider-only single routes and never re-applied
  `CUSTOM_PROVIDERS`, the shared chat path or `ROUTE_GROUPS` — the recommended production
  mode ran with no failover, load-balance, hedge, arbitrage or OpenAI-compatible provider.
- **`TOOL_POLICY` no longer disables streaming deployment-wide** (gated on declared
  tools: `tools` / `tool_choice`, the legacy chat `functions` / `function_call`, or a
  Responses stored `prompt`; anything the extractor governs is still buffered).
- **A quiet reasoning stream no longer opens the circuit, and a hung one still does.** A
  single watchdog abort was a breaker fault; five long thinks on a provider without
  keepalives opened the breaker (fleet-wide under `BREAKER_SHARED`). A run of
  `STREAM_WATCHDOG_BREAKER_THRESHOLD` consecutive stalls now trips the circuit outright
  (`CircuitBreaker.trip`): each stalled stream also records a first-byte success, so the
  per-sample rules alone could never eject a provider that accepts every request and
  then hangs.
- **The semantic cache works on the pgvector default again.** The vector partition was
  joined with a NUL byte, which Postgres rejects in a `text` column; every semantic
  lookup threw and, because the engine awaits it after the exact-tier miss, the WHOLE
  cache was bypassed with `CACHE_SEMANTIC_ENABLED` on pgvector (pre-existing; hidden
  because the in-process Postgres tests strip the vector extension). The separator is
  now the ASCII unit separator.
- **Embeddings requests reserve input-only.** They reserved the 8k default output at the
  unknown-pricing floor (about $0.61 per call) and were refused with 402 near any real
  cap; the unpriced-model warning is throttled to once a minute per model.
- **In-stream enforcement no longer withholds sequential multi-block streams.** Every
  Anthropic server-tool answer (text → `server_tool_use` → text) and multi-part Responses
  streams were failed closed; only interleaved text blocks are now.
- **Per-key allow-lists work in production.** The data-plane key store hard-coded `*`
  because `virtual_key` had no such columns (migration `0025`).
- **Console:** the keys list showed a blank name column (`displayName` vs `name`), the
  shadow-spend ratio rendered `NaN%` (`shadowRatioBps` vs `shadowRatio`), durable role
  grants showed "—" for every subject (`userId`), and the routes page offered
  `latency` / `cost` / `conditional` strategies the gateway rejects on hot-reload (it
  now offers `single` / `loadbalance` / `fallback`; the dry-run panel says it is a local
  projection).
- `CLAUDE.md` named the long-gone `envs/dev` / `envs/prod` Terraform roots.

### Added

- **Per-key scope on mint:** `POST /keys` takes `allowedModels`, `allowedProviders`,
  `expiresAt` and `groups` (validated, audited, returned in the secret-free view); the
  control client and the console key form expose them.
- **Unpriced-model readiness check** (`METER_UNPRICED_CONFIG`, `/ready`, `gulley doctor`).
- **Opt-in live Redis test** for the budget scripts (`GULLEY_TEST_REDIS_URL`).
- `docs/research/competitor-landscape-2026-10.md` — the October 2026 competitor research.

## [0.5.0] — 2026-09-28

A hardening release: two waves of security and correctness fixes from a full
release-readiness audit, spanning the data-plane request pipeline, the control-plane
APIs, the admin console, and the deploy assets. Every fix ships with regression tests;
the data-plane (hot-path) changes went through the adversarial hot-path review.

### Upgrade notes

- **Run the new migrations** with `node dist/control-api/migrate.mjs` before starting the
  planes (compose runs the `migrate` service first; the ECS module ships a one-off migrate
  task; on Kubernetes run it once per release). This release adds `0023` — a unique
  `(workspace_id, name)` index on the route, route-policy, model-alias, smart-routing,
  rate-limit and guardrail collections — and `0024`, which makes the prompt registry
  append-only (`UPDATE`/`TRUNCATE` refused by trigger + `REVOKE`, matching `audit_log`).
- **De-duplicate config-collection names before migrating.** Migration `0023`'s unique
  index will fail to create if a collection already holds two entries with the same name in
  one workspace; resolve the duplicates first (the index creation surfaces them).
- **`GUARDRAILS_WEBHOOK_FAIL_CLOSED` now defaults to `true`.** A bring-your-own DLP webhook
  timeout/outage now withholds the request instead of forwarding it un-scanned, matching the
  managed-plugin posture. Set it `false` to trade that safety for availability.
- **`OIDC_COOKIE_SECURE` is enforced in production.** With SSO enabled under
  `NODE_ENV=production`, boot refuses a non-`Secure` admin session cookie — set
  `OIDC_COOKIE_SECURE=true` (or `OIDC_ALLOW_INSECURE_HTTP=true` for a deliberate non-TLS
  edge).

### Security

- **CEL authorization deny rules now fail CLOSED on an evaluation error.** A `deny` rule
  that threw or yielded a non-boolean was silently treated as a non-match, so a request
  could dodge a deny by making the rule error on the attacker-controlled body — e.g.
  sending `"max_tokens": "999999"` (a string) to defeat
  `deny: request.body.max_tokens > 100000`, forcing a NaN via `int()` of a non-number, or
  tripping the evaluator step limit with a huge array. An erroring deny is now a MATCH
  (denied); `int()`/`double()` of a non-numeric value and ordering-comparing a NaN now
  raise instead of coercing silently. Guard a deny over an OPTIONAL field with
  `has(field) && …` so a legitimately-absent field stays a clean allow. **Behavior
  change** for deny rules that referenced unguarded optional/typed fields.
- **Config export/plan now require platform `config:read`.** `GET /config/export` and
  `POST /config/plan` were scoped by the caller's org, so a merely workspace-scoped admin
  could read (and diff) every sibling workspace's full config document. They now gate on
  `config:read` at the platform scope, matching `/config/drift` and `/config/versions`.
- **CEL evaluator resource bounds.** The parser and evaluator cap expression nesting depth,
  so a pathological operator/GitOps policy raises a typed error instead of overflowing the
  native stack with a `RangeError`; `matches()` rejects a catastrophic-backtracking pattern
  shape (`(a+)+` and friends) at use (there is no native RE2 here by design); and the
  external-authorizer default cache key is depth-bounded, so a deeply-nested request body
  (with `EXTERNAL_AUTHZ_SEND_BODY` on) maps to the configured fail mode instead of a 500.
- **DLP detector coverage.** The native detectors now catch separator-less SSNs and phone
  numbers (`123456789` / `5551234567`) when a matching context word ("ssn", "phone", …)
  sits nearby — the bare forms, common in pasted spreadsheets/CSV/JSON, were previously
  missed. And when a body exceeds the per-scan byte cap, the detector emits a full-span,
  high-confidence `scan_truncated` marker so the cache-sensitivity gate and block/mask
  enforcement fail CLOSED instead of treating the unscanned tail as clean.
- **Guarded egress is DNS-rebind-pinned end to end.** The connect-time pinned agent (which
  refuses an internal/metadata address at dial time) now backs the inbound-JWT and console
  OIDC discovery/JWKS/token fetches, the OIDC token exchange (which carries the client
  secret), Entra Graph, the external authorizer, the audit anchor, the SIEM export, the
  gateway-metrics scrape and the eval runner — not only the DLP webhook and guardrail
  plugins. Previously these had only a boot-time structural URL check, so a configured host
  whose A-record flipped to an internal/metadata address after the check (or a malicious IdP
  discovery document) could reach an internal endpoint.
- **Counters-Redis role separation is enforced at boot.** Budget/rate-limit counters and
  the semantic-vector index require `noeviction`; the cache runs `allkeys-lru`. Sharing one
  Redis instance for the cache and a counter/vector role silently evicted counters under
  memory pressure, bypassing spend enforcement with no error anywhere. Boot now refuses
  `REDIS_COUNTERS_URL` or `REDIS_VECTOR_URL` equal to `REDIS_CACHE_URL` (the reliable guard;
  the runtime `CONFIG GET maxmemory-policy` probe stays best-effort, since managed Redis
  often disables `CONFIG`).
- **Config collection entity names are unique per workspace (DB-enforced).** The route,
  route-policy, model-alias, smart-routing-policy, rate-limit and guardrail collections gain
  a unique `(workspace_id, name)` index (migration `0023`). The name is the GitOps reconcile
  key, but only an in-memory TOCTOU check guarded it, so a concurrent create — or a document
  with two same-named entries — could persist duplicate rows that the name-keyed reconcile
  then silently shadowed. A duplicate now returns 409 (console) / 422 (apply) instead of a
  500 or a shadowed row. Upgrades with pre-existing duplicate names must de-duplicate before
  migrating (the index creation surfaces them).
- **Prompt registry is DB-tamper-evident.** `prompt_version` (append-only, hash-chained)
  now refuses in-place `UPDATE` and `TRUNCATE` via a trigger + `REVOKE` (migration `0024`),
  matching `audit_log`/`config_version` — closing the gap where a version body could be
  rewritten with a recomputed forward chain undetectably. `DELETE` is intentionally left to
  the `ON DELETE cascade` (dropping a version leaves a detectable gap in the sequence).
- **Budget commit is idempotent, and in-memory reservations are reclaimed.** The Redis commit
  script dedupes a resent commit (an ioredis auto-retry after a lost reply) via a TTL-bounded
  committed-ids set gating the increment, so it can no longer double-count committed spend
  (which drove spurious 402s and projection drift). The in-memory (single-node) store gained
  per-reservation expiry, an orphan sweep in `reserve()`, and a `refresh()`, so a request
  that crashes between reserve and commit no longer strands its worst-case reservation and
  permanently shrinks the cap — matching the Redis store's lifetime sweep.
- **The bring-your-own DLP webhook now fails CLOSED by default**
  (`GUARDRAILS_WEBHOOK_FAIL_CLOSED`, previously `false`), matching the managed guardrail
  plugins and the documented "plugins fail closed by default" posture: a webhook
  timeout/outage now withholds the request instead of forwarding it un-scanned. Set it
  `false` to trade that safety for availability. **Behavior change.**
- **`OIDC_COOKIE_SECURE` is enforced in production.** With SSO enabled (`OIDC_ISSUER` +
  `OIDC_CLIENT_ID`) under `NODE_ENV=production`, boot now refuses a non-`Secure` admin
  session cookie — set `OIDC_COOKIE_SECURE=true` (or `OIDC_ALLOW_INSECURE_HTTP=true` for
  a deliberate non-TLS edge). **Behavior change.**
- **Reversible-mask vault nonce widened** from 32 to 96 bits, so a mask token from one
  request cannot collide with another's at enterprise request volume.
- **Indirect-injection spotlighting now marks the legacy OpenAI `role:"function"`**
  tool-output message as untrusted (previously only `role:"tool"` was).
- **JWKS key selection tightened:** a token naming an unknown `kid` no longer falls back
  to an arbitrary key when the JWKS holds more than one key of that type.
- **The audit sanitizer recognizes Gulley's own credential formats**
  (`gk_`/`gko_at_`/`gko_rt_`/`gadm_`/`gses_`), so a raw Gulley token misplaced in a
  non-secret-named field is redacted, not only provider keys.
- **Unkeyed secrets in an audit-only response are excluded from the cache.** The output
  cache-sensitivity gate consulted the policy-*filtered* findings, so on the audit-only
  path (guardrails detect but don't redact/buffer) an opaque bearer/session token or
  generic API key — which the detectors emit *below* the cache-exclusion confidence gate
  and which the policy floor then drops — slipped through, and a response echoing it could
  be cached and replayed to another caller in the same authz scope. The gate now consults
  the raw scanner findings on that path and treats any secret- or entropy-sourced finding
  as too sensitive to cache, regardless of confidence.
- **A 200 whose BODY is an error object is booked as a failure.** An OpenAI-compatible or
  degraded cross-provider-translated backend that reports failure in-band under a 200
  (`{"error":…}` / `{"type":"error"…}`) was recorded as a $0 success, left cacheable, and
  never reached the circuit breaker — the non-streamed analogue of the in-stream
  error-frame handling. It is now recorded as an error, faults the breaker, and is excluded
  from the cache; the raw bytes still reach the client verbatim.

### Fixed

- **Cross-family SSE translators (OpenAI→Anthropic, Gemini→Anthropic) decode UTF-8 across
  chunk boundaries** — a multi-byte code point split between two upstream chunks is no
  longer corrupted to U+FFFD in the client-visible text.
- **A non-streamed hedge loser is metered at worst case.** When a hedged race is won by the
  other leg, a *non-streamed* loser has already had its whole (billed) body generated
  upstream before its headers arrived, yet its bytes are discarded — so it was booked at
  $0. It is now charged worst-case beside the served leg, honoring "always meter partial
  spend on abort/failover". A *streamed* loser is still aborted right after headers and not
  charged (its worst-case would grossly over-bill), matching the existing cascade metering.
- **Admin console.** The FinOps chargeback CSV export quotes/escapes every field and
  neutralizes spreadsheet-formula injection on the attribution key; config **Apply**
  confirms, disables while in flight, and refuses an unknown base version (no more `?? 0`
  silent-overwrite / spurious-conflict); create forms (keys, orgs, workspaces, the
  routes/policies/budgets/guardrails/aliases/rate-limits collections, providers, prompts,
  role grants) disable while a create is in flight (no double-submit duplicates); a
  transient `/auth/me` failure no longer wipes a pasted break-glass token (only a real
  401 does); the copy button reports failure instead of a false "Copied ✓" in an insecure
  context; the observability poll backs off correctly against a persistently unreachable
  metrics listener; and `global-error` / `not-found` boundaries render a styled page for a
  layout-level throw or a bad URL instead of Next's default.

### Changed (deploy)

- **Terraform:** the control-api task role is granted `kms:GetPublicKey`, so the prod tier
  can serve the offline audit-verification key (`GET /.well-known/gulley-audit-key`), the
  WORM/anchor verify routes, and the DR drill — they previously failed with `AccessDenied`
  under `tier=prod`.
- **Compose self-host** pins `LOG_LEVEL` (default `info`) so a verbatim-copied
  `.env.example` no longer runs the production self-host at `debug`.

## [0.4.0] — 2026-09-20

The production-readiness release: a full review/refine pass over the data plane,
the control plane, the console and CLI, and the runtime image. Read the upgrade
notes first — the runtime image and the migration procedure changed.

### Upgrade notes

- **The runtime image is distroless and pre-bundled.** The entrypoints are
  `node dist/gateway/main.mjs` and `node dist/control-api/main.mjs` (plus
  `dist/gateway/doctor.mjs`, `dist/control-api/migrate.mjs`,
  `dist/control-api/audit-verify.mjs`); there is no shell, `pnpm` or `tsx` in the
  image. Any custom deployment that ran the apps through `pnpm`/`tsx` must switch to
  the bundled entries. Helm chart 0.2.0 targets these entries and requires a v0.4.0+
  image.
- **Migrations run from the image.** Apply them with `node dist/control-api/migrate.mjs`
  before starting the planes (compose runs the `migrate` service first; the ECS module
  ships a one-off migrate task; on Kubernetes run it once per release). Migrations
  `0021` (indexes, idempotent ledger writes, truncate guards) and `0022` (durable prompt
  registry) ship in this release. Both planes now report `/ready` 503 until the schema
  matches the build (`DB_SCHEMA_CHECK`, default on).
- **Compose requires `GULLEY_KEY_PEPPER`** and forces `NODE_ENV=production`; the
  console's control-API rewrite is now a runtime proxy, so set `CONTROL_API_URL` on the
  console container instead of a build argument.
- **Delegated admin sessions** (`POST /admin/sessions`) are always minted for the
  calling admin; a caller-chosen `subject` is a label only, and at least one membership
  is required.
- **Image scans are strict** (`.trivyignore` removed): the release workflow fails on any
  unfixed HIGH/CRITICAL finding in the runtime image.

### Security

- **Delegated admin sessions cannot impersonate.** `POST /admin/sessions` always
  mints the token for the calling admin (a caller-chosen `subject` is now only a
  label), requires at least one membership so the anti-amplification check always
  runs, and the durable membership loader is skipped for delegated (`exchange`)
  tokens — a delegated token's grants are its whole authority.
- **OIDC hardening.** Discovery, JWKS and the advertised `token_endpoint` pass the
  outbound egress guard; the discovery `issuer` must match the configured issuer;
  production requires https end to end; all IdP calls are bounded; `/auth/logout`
  revokes the session `jti`.
- **OAuth broker.** The refresh secret is verified before the identity provider is
  consulted (a handle alone can no longer drive a Graph lookup); Graph calls carry a
  deadline; OAuth client saves validate tenancy, grant types and redirect entries and
  re-scope the durable row on upsert.
- **Uniform error bodies.** The control API no longer echoes internal error text
  (driver messages, hosts) in 5xx responses; a lost audit row is a structured
  `audit_lost` log event and an `audit_unavailable` response.

### Fixed

- **DB mode: console edits are durable.** Creating, updating or deleting a
  provider, credential reference, route, policy, budget, rate limit, guardrail or
  model alias in the admin console now commits to the Postgres config tables the
  gateway reconciles from — in one transaction with its audit row and a new
  `config_version` (content hash, YAML, diff summary), followed by a bus signal —
  instead of writing a process-local registry that a restart wiped and the gateway
  never saw. The console's read model re-hydrates from Postgres at boot, after every
  commit, on a foreign config signal and on `CONTROL_API_HYDRATE_INTERVAL_SECONDS`,
  so replicas converge. Duplicate entity names within a workspace are now a 409.
- **Prompt registry is durable in DB mode** (`prompt_template` / `prompt_version`,
  migration 0022): append-only, hash-chained rows; the chain hash now also covers the
  author, timestamp and message, so rewriting who/when is detectable; template
  renders resolve own properties only.
- **Schema-version readiness.** Both apps compare drizzle's applied-migrations table
  with the migrations the build ships and report `/ready` 503 while the database is
  behind (or was never migrated) — `DB_SCHEMA_CHECK`.

### Fixed (gateway hot path)

- **Abort attribution and the single teardown.** Every abort goes through one path
  and destroys the live body, so a client disconnect during a slow pre-dispatch stage
  is no longer forwarded and billed into a dead socket, and a replayed (cascade) or
  paused (backpressure, decompressor) body can no longer strand its teardown. Only a
  client disconnect is `aborted`; a watchdog stall, deadline, transform or socket
  fault is an `error` with `abortReason` on the ledger, request log, audit row and
  span, faults the breaker, and ends the stream with a terminal error frame instead
  of a silent clean end.
- **Never replay an accepted request.** A headers timeout (request sent, never
  answered) is not retried on the same target, failed over, or replayed past a hedge
  race: one breaker fault, a 504, the leg metered at worst case. A hedge leg or a
  cascade tier-1 escalation the provider accepted but never answered is metered at
  worst case beside the served leg (`#hedge-timeout` / `#cascade-tier1` ledger rows)
  instead of refunded. `UPSTREAM_HEADERS_TIMEOUT_MS` (default 10 min) replaces the
  hard-coded 60 s.
- **Healthy upstreams are not blamed.** Client backpressure no longer trips the
  inactivity watchdog against the paused upstream: the idle budget bounds the
  client's drain, and a reader that never drains is torn down as a client abort with
  its partial spend metered. Tenant-credential faults, adapter refusals
  (`ProviderRequestError` → 400) and aborts release half-open probe tokens and
  limiter slots without a fault — on the cascade escalation path too; the adaptive
  limiter is fed time-to-first-byte against a windowed baseline; `Retry-After` is
  clamped (5 min) and the breaker's ejection floor is capped at `maxCooldownMs`.
- **In-band errors are failures.** An `event: error` / `{"error":…}` frame under a
  200 (native, OpenAI-chat and Gemini translations, Bedrock `exception` and `error`
  eventstream frames) is recorded as an error and faults the breaker. The Bedrock
  frame is delivered ahead of a clean end even under client backpressure, and the
  gateway never appends a second, generic frame behind an upstream's own.
- **Metering.** Cached prompt tokens on translated routes are billed (they were
  $0); a `stream:false` client on a translating adapter is metered from the SSE;
  `max_tokens` is clamped so a negative value cannot skip the reservation; a
  budget-downshifted answer is never cached under the original model's key; the
  in-memory budget store no longer prunes an idle scope that still holds committed
  spend (lifetime and long-window caps were silently reset to $0 once a day).
- **Store outages degrade loudly.** Budget, rate-limit and cache-lookup fail-open
  are logged, audited, metered (`gulley_store_errors_total`) and flagged on the
  request log and span; key-store / grant-store outages answer 503 + `Retry-After`
  with a generic body; every sink failure counts (`gulley_sink_errors_total`); a
  completion record is emitted for every request, including denials and 5xx.
- **Guardrails.** Hold-then-flush enforcement inspects the logical text of a
  buffered stream (a secret split across two deltas passed as audit-only); the input
  scan runs over the decoded JSON (a `@` escape evaded every detector); overlap
  resolution is O(n log n) with a fail-closed 10k-finding cap; vault tokens carry a
  per-vault nonce; a windowed-enforcer block is terminal for the SSE rewriters;
  plugin verdicts compose with the native transform; plugin degradation is metered,
  and the Azure / Bedrock plugins gain fail-closed knobs.

### Fixed (console, CLI, client)

- **Console.** A `401` from any call signs the console out (with a reason) instead of
  leaving a dead token in place; every call has a 15 s deadline and a typed
  `ApiError`; every list panel shows the real error with a Retry instead of an empty
  state; destructive actions (rotate/disable key, delete org/workspace/entity/suite,
  revoke session/grant/membership) confirm first; the log browser no longer fetches per
  keystroke and guards against out-of-order responses; the observability page backs
  off while the gateway listener is down and labels a stale snapshot; the audit trail
  pages with "Load more"; the shell shows the control API's real version and
  reachability; the evidence-bundle download and log-level change report failures;
  a route-segment error boundary replaces a blank page; security headers (CSP,
  nosniff, frame-ancestors) are set; Export (CSV) and Hot-reload (save through the
  audited route write) are wired; SSO keeps a deep link via a same-origin `return_to`.
- **Console proxy.** `/control/*` is proxied at request time from `CONTROL_API_URL`
  (a runtime env; one image per environment) instead of a build-time rewrite.
- **CLI.** `gulley init` expands `~` in pack paths (it used to create `./~`); the
  credential lock records its holder's pid and never evicts a live holder; broker
  calls carry a 10 s deadline; discovery is cached in the profile; the credentials
  file is written atomically and a corrupt one gives clear guidance; `logout` says
  whether the broker actually revoked; re-login revokes the previous family; device
  polling survives transient network errors.
- **control-client.** Per-call deadline (`timeoutMs`), typed `ControlNetworkError`,
  and a non-JSON error page keeps its status instead of surfacing as a `SyntaxError`.

### Changed (runtime + deploy)

- **Distroless, pre-bundled runtime image.** `scripts/bundle.mjs` (esbuild) bundles
  both apps (and the migrate / doctor / audit-verify entries) into `dist/`, stamps
  the version + git sha (`/health`, `gulley_build_info`, OTel `service.version`,
  log lines), and copies the migrations; the image is
  `gcr.io/distroless/nodejs22-debian12:nonroot` (with Debian's current security build of
  its `libssl3` overlaid, so a lagging base rebuild cannot fail the release scan) with
  production-only, per-app dependency trees
  (`pnpm deploy`) — no tsx,
  esbuild, vitest, drizzle-kit, shell or package manager at runtime. The console
  image runs Next's standalone server on the same base. Trivy scans run **before**
  every push with no exceptions (`.trivyignore` and the esbuild skip-dirs are gone).
  **Deployments must switch their commands** to the bundled entries
  (`dist/gateway/main.mjs`, `dist/control-api/main.mjs`; migrations via
  `dist/control-api/migrate.mjs`) — compose, the Helm chart (0.2.0, appVersion
  v0.4.0) and the Terraform module are updated.
- **Compose:** a one-off `migrate` service runs first and both planes wait for it;
  `stop_grace_period` 120 s; per-service node-based healthchecks; control-api and
  metrics ports bound to loopback; `NODE_ENV=production` forced and
  `GULLEY_KEY_PEPPER` required; Node heap caps.
- **Helm:** node-based `preStop` (no shell in the image), `/ready` readiness for the
  control-api, 5 s probe timeouts + startupProbes, per-plane `SHUTDOWN_GRACE_MS`
  derived from that plane's grace/preStop/buffer (render fails on a non-positive
  budget), `NODE_OPTIONS` heap caps, Prometheus scrape annotations, a NetworkPolicy
  for the control-api, `pullPolicy: Always` for a `latest` tag, and a refusal to
  render a credential-bearing `DATABASE_URL` into the ConfigMap.
- **Terraform (ECS):** bundled entries + exec-form health checks, read-only root
  filesystems, Node heap caps, the prod WORM mirror actually wired (bucket, region,
  retention, audit-export signing key) with `PutObject`/`PutObjectRetention` on the
  control role, Aurora backup retention (prod 35 d / test 1 d, tags on snapshots,
  Postgres logs to CloudWatch), `/metrics` and `/live` no longer routed by the ALB,
  secret recovery window + ECR `force_delete` tier-conditional. **EKS:** the
  `metrics-server` addon (the HPA had nothing to read), `bedrock:ApplyGuardrail` on
  the IRSA role, prod refuses an API endpoint open to `0.0.0.0/0`.
- **CI:** the deploy manifests (Helm lint/template + compose) are gated in both
  CIs; the release workflow refuses `latest` from a manual run, scans before pushing
  to ECR too, publishes the console image (`ghcr.io/bogware/gulley-web`), and the
  Azure pipeline verifies the cosign binary's checksum; the hot-path guard fails in
  strict mode when the base ref is missing; `pnpm bundle` is part of `ci/verify.sh`.
- `gulley doctor` errors under `AIR_GAPPED` when a provider still points at its
  public endpoint; the DR runbook verifies with `audit:verify`; docs describe the
  runtime image, the console proxy and the gateway's egress model accurately.

### Changed

- SCIM deprovision revokes every live session for the user (set-based, by subject
  and email) in one transaction; SCIM list endpoints honour `startIndex`/`count`;
  malformed uuid path ids are 404s (SCIM member values: 400 `invalidValue`).
- `OIDC_SUBJECT_CLAIM`, `OIDC_FETCH_TIMEOUT_MS`, `OIDC_ALLOW_INSECURE_HTTP` and
  `ENTRA_GRAPH_TIMEOUT_MS` knobs; platform-wide grants (`orgId: "*"`) persist in DB
  mode; collection update audit rows record what changed (name/config hashes); audit
  reads are paged from the backend and chain verification streams in batches.

## [0.3.0] — 2026-09-14

First public release. Gulley is a self-hostable, enterprise LLM gateway: one
container fronting every major provider that adds routing, cost/budget
enforcement, caching, guardrails, RBAC, identity, and a tamper-evident audit trail
behind a single base-URL change.

### Added

- **Data plane (gateway).** Streaming, byte-faithful proxy for the Anthropic
  Messages schema (canonical) plus OpenAI, Bedrock, and Azure, with a fixed
  pipeline: fail-closed virtual-key auth → model/provider authz → input
  guardrails → cache lookup → TOCTOU-safe budget reserve → pre-first-byte
  failover → streamed metering and output scanning → one centralized teardown.
- **Routing.** Single / load-balance / fallback / conditional strategies, circuit
  breaking, cheapest-upstream selection, hedging, and same-model cross-provider
  arbitrage with per-target model-id rewrite.
- **Cost & budget.** Per-provider metering from raw provider usage, reserve/commit
  budgets (Redis + in-memory), per-attribution daily caps, and a durable
  cost-breakdown ledger with chargeback by workspace/model/provider/agent.
- **Caching.** Two-tier exact + semantic cache, partitioned by authz scope, with
  PII/secret-flagged responses excluded and cache↔DLP coexistence.
- **Guardrails / DLP.** Native RE2-safe detectors, reversible tokenization vault,
  in-stream redaction/blocking, indirect-injection spotlighting, and LLM-leg
  tool-call governance.
- **Governance.** Deny-by-default RBAC, coding-agent attribution, central model
  allow/deny policy, and shadow-spend reconciliation.
- **Identity.** OAuth device + auth-code/PKCE broker with refresh-reuse detection;
  OIDC (Entra/Azure AD) SSO for the admin console; inbound-JWT auth for the data
  plane; SCIM user provisioning; break-glass bootstrap.
- **Coding-harness OAuth, end to end.** A developer-side `gulley` CLI
  (`packages/cli`: `login` / `token` / `logout` / `status`, plus signed-pack
  `verify` / `init`) runs the RFC 8628 device flow against the broker and acts as
  Claude Code's `apiKeyHelper` / Codex's `[model_providers.gulley.auth]` command,
  refreshing tokens ahead of expiry under a cross-process lock. The broker
  publishes RFC 8414 metadata and RFC 7662 introspection, serves a consent page,
  and the console registers OAuth clients and generates agent configs. See
  `docs/HARNESS_OAUTH.md`.
- **Durable tenancy (DB mode).** Orgs/workspaces created in the console are written
  through to Postgres and hydrated at boot (and after a config apply), so key
  minting and OAuth-client registration survive a restart.
- **Compliance.** Hash-chained audit trail with S3 Object Lock (WORM) mirroring,
  KMS-asymmetric signing, external anchoring, downloadable evidence bundles, SIEM
  export, BYOK envelope encryption with crypto-shred, data-residency/ZDR
  enforcement, and an air-gapped posture.
- **Admin console.** Next.js control plane for observability, logs, routing, config
  (GitOps editor), FinOps, identity, and compliance.
- **Deploy.** A single adaptable Terraform module (test/prod tiers) for AWS
  (ECS Fargate, Aurora Serverless v2, ElastiCache, ALB, KMS, Secrets Manager) with
  operator knobs (`enable_oauth_broker`, `enable_onboarding_packs`,
  `gateway_extra_env` / `control_extra_env`, public-URL env), a Helm chart, and a
  docker-compose self-host. Published as a multi-arch (amd64+arm64), cosign-signed
  container image with SBOM + provenance at `ghcr.io/bogware/gulley`.

### Fixed

_Resolved during pre-release hardening (these never shipped in a public release):_

- **Gateway metering:** a passthrough OpenAI-wire chat-completions stream whose
  client omitted `stream_options.include_usage` was billed $0 (no usage frame,
  budget unenforced). The gateway now asks the backend for usage on the client's
  behalf (`METER_INJECT_STREAM_USAGE`, default on), after every request transform.
- **Gateway DLP:** the input-guardrail mask replaced the outbound bytes but not the
  parsed request, so a budget-aware model downshift (and a cascade escalation,
  which used a copy taken before masking) re-sent the **unmasked** prompt upstream.
  Both now forward the final masked/transformed body, and a mask whose output
  cannot be mirrored into the parsed request is refused (422,
  `guardrail.transform_unforwardable`) rather than forwarded unmasked.
- **OAuth broker:** RFC 7662 `POST /oauth/introspect`; `gulley token` introspects
  its cached token so an admin revocation or reuse-triggered family kill surfaces
  as "run `gulley login`" at the agent's next helper run instead of opaque 401s.
- Generated agent configs never carry a credential (OAuth mode wires the token
  helper; key mode instructs an export), fixing a Claude Code `${VAR}` non-expansion
  401; Codex configs use `wire_api = "responses"`; the gateway accepts a brokered
  token on `x-api-key` as well as the bearer; IPv6 loopback (`[::1]`) PKCE redirects
  are accepted; and `gulley init` merges into an existing settings file.

[Unreleased]: https://github.com/bogware/gulley/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/bogware/gulley/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/bogware/gulley/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/bogware/gulley/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/bogware/gulley/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bogware/gulley/releases/tag/v0.3.0
