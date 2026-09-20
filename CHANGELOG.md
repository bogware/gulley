# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  `gcr.io/distroless/nodejs22-debian12:nonroot` with production-only, per-app dependency trees
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

[Unreleased]: https://github.com/bogware/gulley/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/bogware/gulley/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bogware/gulley/releases/tag/v0.3.0
