# Gulley — Build Roadmap

Phased delivery. Each milestone is independently demoable and ends in a working, tested slice. Cross-cutting from M1 onward: golden SSE fixtures per provider, security fuzz tests (credential-leak across all auth modes, ReDoS on the regex set), and an always-green CI.

The guiding sequence: **prove the whole pipeline against one provider end-to-end (Anthropic + Claude Code), then widen coverage, then deepen governance, then productionize the infra.**

---

## M0 — Foundation & scaffold

Stand up the monorepo and the walking skeleton.

- Turborepo + pnpm workspace; `apps/*`, `packages/*`, `infra/`, `ci/` per [ARCHITECTURE §15](./ARCHITECTURE.md#15-repository-structure).
- Tooling: TypeScript strict, ESLint/Prettier, Vitest, Playwright, Changesets.
- `docker-compose` dev stack (Postgres + Redis×3 roles) + `.env` contract.
- `packages/storage`: Drizzle schema baseline + first migration; role-split Redis clients.
- `apps/gateway` + `apps/control-api`: Fastify bootstrap, health/readiness probes, structured logging.
- Multi-stage distroless container (non-root); CI skeleton (both GH Actions + Azure Pipelines calling `ci/`).

**Done when:** `pnpm dev` brings up gateway + control-api + web against local Postgres/Redis; both CIs green on an empty test suite; container builds and runs healthcheck.

**Delivered.** Turborepo + pnpm workspace (`apps/*`, `packages/*`, `infra/`, `ci/`); TypeScript strict-plus, ESLint flat config, Prettier, Vitest, Playwright (`apps/web/e2e`); `docker-compose.yml` with Postgres + the three role-split Redis instances and `.env.example` as the env contract (a CI test enforces every knob is listed); `@gulley/storage` Drizzle schema + migrations + role-split Redis clients; both apps boot health-only on incomplete config (`/health` always, `/ready` 503 until wired); a distroless, non-root, pre-bundled runtime image (`scripts/bundle.mjs`, see M6) with GitHub Actions and Azure Pipelines calling `ci/verify.sh`. Not adopted: Changesets — the changelog is hand-maintained.

---

## M1 — Core proxy: Anthropic-first, drop-in Claude Code

The vertical slice that proves the pipeline.

- Native passthrough `POST /anthropic/v1/messages` with **full SSE fidelity** (event-order state machine, `input_json_delta` reassembly, heartbeats, cancellation teardown).
- Auth resolver — **virtual keys mode only** (HMAC+KMS pepper, prefix+lookup, epoch revocation); deterministic mode selection; fail-closed.
- Principal/Scope + RBAC skeleton; deny-by-default.
- Cost metering from raw Anthropic `usage` (incl. cache tokens) → `spend_ledger`; request-log rollups.
- Audit log baseline (hash-chained rows) + centralized teardown guaranteeing meter+audit+span-close.

**Done when:** `ANTHROPIC_BASE_URL=<gulley> ANTHROPIC_API_KEY=<virtual-key>` runs a real Claude Code session through the gateway, streamed, metered, and audited; cancel mid-stream meters partial spend.

**Delivered.** `/anthropic/v1/messages` (and `/v1/messages`) as a hijacked raw-byte pipe with the SSE state machine (`packages/providers/src/sse.ts`), `input_json_delta` reassembly, backpressure and a post-first-byte inactivity watchdog; virtual keys (`gk_` prefix + lookup, HMAC-SHA256 under `GULLEY_KEY_PEPPER`, epoch bump on disable/rotate, expiry, last-used) with deterministic, fail-closed mode selection; `@gulley/rbac` deny-by-default Scope; metering from raw Anthropic `usage` (cache tokens included) into `spend_ledger`, `request_log` and the usage rollups behind `/admin/analytics/*`; hash-chained `audit_log`; one centralized `teardown()` with one `abortWith(reason)` path (only a client disconnect is `aborted`, every other abort is an `error` with `abortReason`). Live-validated with `pnpm --filter @gulley/gateway live:anthropic`.

---

## M2 — Multi-provider + routing / load-balancing / failover

Widen coverage and make the gateway earn its keep.

- Adapters: OpenAI Chat Completions, **OpenAI Responses (Codex)**, AWS Bedrock (decode `vnd.amazon.eventstream` → SSE; inference-profile IDs + CRIS IAM), Azure AI Foundry (Bearer→api-key/Entra conversion).
- Canonical (Anthropic Messages) model + bidirectional translation; **capability preflight matrix** stage; provider-affine-artifact pinning.
- Recursive routing config (`single|loadbalance|fallback|conditional`); weighted LB; **pre-first-byte-only failover** + idempotency; circuit breakers; fallback taxonomy (plain / context-window / content-policy).
- Additional auth modes: gateway-brokered path stubbed, transparent passthrough (network-locked) for Anthropic Enterprise.

**Done when:** Codex runs through the gateway via the Responses API; a forced provider outage fails over cleanly pre-first-byte and returns a terminal SSE error post-first-byte; cross-provider routing works for a non-lossy request.

**Delivered.** Adapters for OpenAI Chat Completions + Responses (`/openai/v1/*`, `[DONE]` handling, `stream_options` usage injection), AWS Bedrock (`vnd.amazon.eventstream` decode → SSE; `exception`/`error` frames re-emitted as an Anthropic `event: error` then a clean end; inference-profile ids), Azure AI Foundry (Bearer → `api-key`), Gemini/Vertex native (`docs/NATIVE_PROVIDERS.md`) and OpenAI-compatible presets (`CUSTOM_PROVIDERS`); canonical Anthropic translation (`AnthropicToOpenAIAdapter`) that refuses provider-affine content (`tools`, `thinking`, non-text blocks) with a terminal 400 instead of dropping it; strategies `single | loadbalance | fallback` (`packages/routing`), weighted / P2C least-load / cheapest / fastest selection, rendezvous session affinity, `ROUTE_GROUPS` overlay; pre-first-byte-only failover with bounded same-target retry, hedging, circuit breaker (shared across replicas opt-in, half-open single probe), passive outlier ejection and an adaptive concurrency limiter; a headers timeout is never replayed; in-band `error` frames under a 200 fault the breaker; cascade routing (`CASCADE_POLICY`) escalates a cheap tier on refusal / truncation / context-window. **Not delivered as designed:** a general capability preflight matrix (preflight is per-adapter translation refusal), a `conditional` strategy node (conditional routing is the model router + tenant overrides + smart routing + CEL), the named `content_policy_fallbacks` chain, and transparent upstream OAuth passthrough (the principal kind is reserved, not wired); the brokered path shipped in full under M5.

---

## M3 — Cost, budgets & observability

Make spend enforceable and traffic observable.

- **Reserve/commit hard caps** (atomic Lua); soft budgets with bounded overshoot; refunds on completion; budgets at org/workspace/project/key.
- Per-provider cost functions + **golden usage fixtures** (regression-tested inclusion semantics); `stream_options.include_usage` injection/stripping.
- OTel GenAI emitters (spans + metrics), **async bounded drop-oldest export**, tail-sampling, content-OFF default, credential scrubber (always-on).
- Native UI: live/recent ops dashboards + budget views from Postgres/Redis.

**Done when:** a budget-exceeding burst of concurrent streams is rejected without breaching the cap; traces/metrics land in an external OTel backend with correct token/cost attributes; the OTel backend going down doesn't affect proxying or budgets.

**Delivered.** `@gulley/budget` reserve/commit (Redis Lua `EVALSHA` + an in-memory store), worst-case reservation at admission with a live-stream refresh and orphan sweep, commit/refund released first in teardown; caps at workspace, per-model (`BUDGET_MODEL_CAPS`) and per-attribution (`BUDGET_ATTR_CAPS`); soft-threshold alerts + webhook (`BUDGET_ALERT_*`) and budget-aware downshift (`BUDGET_DOWNSHIFT_*`); a loud, audited fail-open/closed policy for a counter-store outage (`BUDGET_FAIL_OPEN`); `@gulley/cost` per-provider cost functions with golden usage fixtures; `stream_options.include_usage` injection (the extra final chunk is forwarded, not stripped); partial-spend metering on every abort and worst-case metering of accepted-but-unanswered legs; `@gulley/telemetry` OTel GenAI spans + metrics with async bounded export, content off by default, the always-on credential scrubber (`@gulley/redact`) and W3C trace propagation; Prometheus `/metrics` on a separate listener (`@gulley/metrics`); console dashboards (Overview, Analytics, Observability, FinOps chargeback + shadow-spend). **Not delivered:** soft budgets with bounded overshoot (every cap is hard), org/project-level cap tiers (workspace is the tenant boundary), tail-sampling (head sampling by `TRACE_SAMPLE_RATIO`).

---

## M4 — Guardrails, PII & caching

The governance + performance layer.

- Native detection (RE2 regex + secret-scan + entropy + NER) in a worker pool; parallel checks, short-circuit on BLOCK; lifecycle hooks (`pre/post/during/logging`).
- **Streaming windowed guardrails-post**; per-route `buffered` opt-in; reversible-tokenization vault (PHI-grade, per-request scope).
- Provider guardrail plugins (Bedrock Guardrails, Azure Content Safety/Prompt Shields, Azure Language PII).
- Two-tier cache: exact-hash + semantic (scope-partitioned keys, PII/secret exclusion), cache-control headers + `cache-status` response header.

**Done when:** PII is masked bidirectionally on streamed responses without buffering the whole body; a repeated request served from exact cache with `cache-status: HIT` and zero spend; semantic cache opt-in works and is correctly partitioned by principal.

**Delivered:** `@gulley/guardrails` — native detector (bounded/ReDoS-safe regex + secret-prefix scan + Shannon-entropy catch-all; Luhn-validated cards; O(n log n) overlap resolution with a fail-closed 10k-finding cap; an opt-in prompt-injection/jailbreak detector), per-request reversible tokenization vault with nonce'd tokens, windowed streaming primitives (`StreamingScanner` audit, `StreamingReplacer` detokenize, the `STREAMING_ENFORCE` rewriters), and a `GuardrailEngine` with **audit** (default) / **block** / **mask** / **redact** policies per direction whose native transform composes with plugin verdicts. Plugins: Bedrock Guardrails, Azure AI Content Safety, OpenAI Moderation, Google Model Armor and a BYO DLP webhook — all fail-closed by default with a shared `GUARDRAILS_PLUGIN_TIMEOUT_MS`, no redirects, DNS-pinned egress. Beyond the plan: indirect-injection spotlighting (`GUARDRAILS_SPOTLIGHT`), CEL tool-call governance (`TOOL_POLICY`), a persisted KMS-enveloped mask vault with control-plane reveal and BYOK crypto-shred. `@gulley/cache` — scope-partitioned exact keys (volatile-field-stripped canonicalization) + a semantic tier (`EmbeddingProvider` + pluggable `VectorIndex`); in-memory stores for CI, **pgvector the prod default** (+ Postgres exact, Redis exact, Redis-Stack vector adapters in `@gulley/storage`; migration 0003 adds `CREATE EXTENSION vector` + an HNSW cosine index); `Cache-Control: no-cache` / `no-store` honoured, `x-gulley-cache` on every response. Gateway wires guardrails-pre (403 on block, tokenize-on-mask + response detokenize), a pre-budget cache lookup (a hit is $0 and never touches an upstream), streaming output audit, and buffered output enforcement; telemetry gains `gulley.cache.status` + `gulley.guardrail.*` attributes. **Live-validated** (pennies): `cache:check` (exact + semantic hits via real OpenAI embeddings against real Anthropic), `guardrail:check` (audit passthrough / 403 block / mask-reaches-upstream + client-side detokenize, all real Anthropic), `bedrock-guardrail:check` (real Bedrock `ApplyGuardrail`). **Scope note:** streaming **output** enforcement is audit-only _by default_; it enforces in-stream (redact / reversible mask / terminal block over text deltas on Anthropic Messages, OpenAI `chat.completions` and Responses streams) with `STREAMING_ENFORCE`, or by hold-then-flush with a route's `holdStreamedOutput`; thinking and tool-argument frames are still audit-only in-stream. Not built: the NER/worker-pool tier, Azure Prompt Shields / Azure Language PII plugins; RE2 remains a documented seam for operator-supplied custom regexes (built-ins are already linear-time). Streaming _input_ masking is full (request body is available whole).

---

## M5 — Control-plane depth, OAuth broker & config/GitOps

Make it administrable and auditable.

- Full admin UI: orgs/workspaces/projects, users/roles, virtual keys, providers/credentials, routes/policies, budgets, rate limits, guardrails.
- **OAuth broker** — device flow + auth-code/PKCE (S256), Entra-backed, short-lived tokens, refresh with reuse-detection, revoke on deprovision.
- Config ↔ versioned YAML serialization (canonical, optimistic concurrency, plan/dry-run diff, drift-detection report); YAML apply through the same audit/RBAC path.
- **SOC 2 hardening:** S3 Object Lock WORM audit sink + chain verification; no-content / no-credential modes gated at every sink; SSRF lockdown; split KMS keys.

**Done when:** an admin configures a full routing+policy setup in the UI, exports it to YAML, and re-applies it via GitOps with an audit trail; a developer authenticates a harness via the OAuth broker; audit rows are tamper-evident and mirrored to WORM storage.

**Delivered** (split M5.1–M5.4, each live-validated + committed). **M5.1** `@gulley/rbac` (deny-by-default roles, fail-closed `can`) + `@gulley/egress` (SSRF guard) + shared foundations in `@gulley/core` (branded `SecretRef`), `@gulley/pipeline` (`assertNoInlineSecret` build-failing guard + `GuardedAuditSink` redact-not-throw), `@gulley/auth` (bootstrap-admin + HMAC `gses_` sessions, fail-closed `resolveAdmin`); control-api CRUD with every write hash-chain-audited; migration 0004 makes `audit_log` append-only. **M5.2** `@gulley/oauth` — device + auth-code/PKCE (S256-only), broker-issued tokens, refresh rotation with **secret-authoritative reuse detection** (superseded-reuse revokes the family; forged/lost-race do not), revoke-on-deprovision, ES256-pinned id_token verify; migration 0005. **M5.3** `@gulley/config` — canonical DB↔YAML, `config_version` + **optimistic concurrency**, plan/diff, drift-report, secret-ref serialization guard; apply through the audit/RBAC path; migration 0006 (append-only). **M5.4** `@gulley/worm` (S3 Object Lock COMPLIANCE mirror + signed chain verify), `@gulley/crypto` (split-KMS envelope), `@gulley/redact` (no-content + span allowlist + header denylist). **Live-validated:** rbac/oauth/config checks over real HTTP (in-memory stores); and **real AWS** — `worm:check` proved S3 Object Lock immutability (delete/shorten-retention denied), `kms:check` real GenerateDataKey/Decrypt with per-class/AAD isolation, `ssrf:check` real DNS-rebind blocking. **Seams since closed:** Entra OIDC SSO for the console with group/App-Role → RBAC, SCIM Users + Groups and Graph revoke-on-deprovision (`docs/ENTRA_SETUP.md`); Postgres-backed adapters for every store, with DB-mode console CRUD committing through `DurableConfigWriter` (mutation + audit row + `config_version` in one transaction, then a bus signal; the in-memory registries are a hydrated read model, duplicate names per workspace → 409) and a durable hash-chained prompt registry (migration 0022); KMS-asymmetric signing of attestations and WORM batches (`GULLEY_AUDIT_SIGNING_KMS_ARN`) plus external anchoring, evidence bundles and SIEM export; per-class CMKs in the Terraform module; the coding-harness OAuth runbook end to end (`docs/HARNESS_OAUTH.md`: `gulley` CLI, consent page, introspection, signed onboarding packs); delegated admin sessions that can only mint for the caller (`src: exchange`, ≥1 membership) and audited break-glass; and the admin **console** (`docs/ADMIN_UI.md`).

---

## M6 — Infrastructure, CI parity & release hardening

Production on AWS.

- Terraform modules (`network`/`data`/`security`/`compute`/`edge`/`observability`) + `dev` (single-AZ) and `prod` (multi-AZ) root stacks.
- ECS Fargate + ALB **SSE-tuned** (idle ≥300s, deregistration delay, fast drain), autoscaling on connection-count + event-loop-lag, warm-readiness gating.
- Aurora Serverless v2, Redis×3, VPC interface endpoints, Bedrock cross-account assume-role with `ExternalId` + scoped session policy.
- GH Actions + Azure Pipelines at parity via `ci/`; image to ECR; SBOM + image/dep scanning; `workflow_dispatch`-only dependency-bump workflow (single grouped PR — no scheduled automation).
- Full security-review pass (the M1–M5 fuzz/guard tests as gates), load test of the streaming hot path, runbook + docs.

**Done when:** `terraform apply` stands up a working multi-AZ prod environment serving streamed traffic through the ALB; both CIs deploy identically; the security-review checklist passes.

**Delivered** (M6.1–M6.3, then consolidated for the public release). **M6.1** the six-module layout was folded into **one adaptable root module** (`infra/terraform`: `network.tf`, `security.tf`, `data.tf`, `compute.tf`, `edge.tf`, `observability.tf`) with a `tier` preset — `test` (single-AZ, 1 NAT, shared Redis node, Fargate Spot, no WORM) or `prod` (3 AZs, NAT per AZ, Aurora multi-AZ, Redis×3 role-split, interface endpoints, S3 Object Lock COMPLIANCE, deletion protection) — every knob overridable and environments as `.tfvars`; VPC interface endpoints for ecr/secretsmanager/kms/logs/sts/bedrock-runtime + an S3 gateway endpoint; split-KMS per class + rotation, Secrets Manager entries, least-privilege task roles, optional cross-account Bedrock assume-role with ExternalId; Aurora Serverless v2 with RDS-managed password and backup retention; **SSE-tuned ALB** (idle 300 s, deregistration 180 s, TLS 1.3), ARM64 Fargate task definitions with read-only root filesystems and Node heap caps, circuit-breaker deploys, `ALBRequestCountPerTarget` autoscaling; DNS-validated ACM; immutable scan-on-push ECR. `INSTALL.md` is the ordered two-phase runbook (infra → images/secrets/migrate task → services). Alongside it: `infra/eks` (EKS + IRSA + Graviton node group for the Helm chart), `deploy/helm/gulley` (chart 0.2.0, node-based probes/preStop, per-plane `SHUTDOWN_GRACE_MS`, NetworkPolicy) and `deploy/docker-compose.prod.yml` (one-off `migrate` service first, `NODE_ENV=production` forced). `bash ci/tf-check.sh` (fmt + validate) and `ci/helm-check.sh` gate both roots and the manifests. **M6.2** bounded graceful SIGTERM drain in both mains (`SHUTDOWN_GRACE_MS` 110 s under the 120 s stopTimeout, upstream-pool close, Last-Event-ID reconnect contract), Node as PID 1, and the **distroless pre-bundled runtime image** (`scripts/bundle.mjs` → `dist/*/main.mjs` + `migrate` / `doctor` / `audit-verify` entries, `pnpm deploy` production trees, version/sha stamped into `/health` and `gulley_build_info`, `/ready` gated on the DB schema). **M6.3** CI parity via shared `ci/verify.sh` (format, lint, typecheck, test, build, bundle), `ci/build-image.sh` (multi-arch, SBOM + provenance, cosign) and `ci/hotpath-guard.sh`; GitHub Actions `ci`, `release` (OIDC, Trivy HIGH/CRITICAL gate before every push, images published to GHCR + ECR) and `dependency-bump` (**workflow_dispatch only — no schedule/Dependabot**); Azure DevOps at parity. The M1–M5 credential-leak / ReDoS / guard tests run in `verify`, so the security review is a standing CI gate. **Still manual:** a `terraform apply` against a real account is an operator step per `INSTALL.md`; the load test of the streaming hot path is `pnpm --filter @gulley/gateway load:check`-style manual runs, not a CI gate.

---

## Post-GA seams (not v1)

Multi-tenant activation (per-tenant upstream credentials and per-tenant route overrides already ship — see `docs/MULTI_TENANCY.md`; noisy-neighbour controls and per-tenant residency/key separation do not), HIPAA/FedRAMP/EU-residency full impl (a deployment-wide residency/ZDR policy, `RESIDENCY_*`, and the air-gapped posture ship; per-tenant residency does not), first-class client embeddings endpoint (`/v1/embeddings` is a passthrough today), multimodal/batch first-class handling, contextual grounding (semantic/smart routing ships as `SMART_ROUTING_ENABLED`), multi-region active/active.
