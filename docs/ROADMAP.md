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

---

## M1 — Core proxy: Anthropic-first, drop-in Claude Code

The vertical slice that proves the pipeline.

- Native passthrough `POST /anthropic/v1/messages` with **full SSE fidelity** (event-order state machine, `input_json_delta` reassembly, heartbeats, cancellation teardown).
- Auth resolver — **virtual keys mode only** (HMAC+KMS pepper, prefix+lookup, epoch revocation); deterministic mode selection; fail-closed.
- Principal/Scope + RBAC skeleton; deny-by-default.
- Cost metering from raw Anthropic `usage` (incl. cache tokens) → `spend_ledger`; request-log rollups.
- Audit log baseline (hash-chained rows) + centralized teardown guaranteeing meter+audit+span-close.

**Done when:** `ANTHROPIC_BASE_URL=<gulley> ANTHROPIC_API_KEY=<virtual-key>` runs a real Claude Code session through the gateway, streamed, metered, and audited; cancel mid-stream meters partial spend.

---

## M2 — Multi-provider + routing / load-balancing / failover

Widen coverage and make the gateway earn its keep.

- Adapters: OpenAI Chat Completions, **OpenAI Responses (Codex)**, AWS Bedrock (decode `vnd.amazon.eventstream` → SSE; inference-profile IDs + CRIS IAM), Azure AI Foundry (Bearer→api-key/Entra conversion).
- Canonical (Anthropic Messages) model + bidirectional translation; **capability preflight matrix** stage; provider-affine-artifact pinning.
- Recursive routing config (`single|loadbalance|fallback|conditional`); weighted LB; **pre-first-byte-only failover** + idempotency; circuit breakers; fallback taxonomy (plain / context-window / content-policy).
- Additional auth modes: gateway-brokered path stubbed, transparent passthrough (network-locked) for Anthropic Enterprise.

**Done when:** Codex runs through the gateway via the Responses API; a forced provider outage fails over cleanly pre-first-byte and returns a terminal SSE error post-first-byte; cross-provider routing works for a non-lossy request.

---

## M3 — Cost, budgets & observability

Make spend enforceable and traffic observable.

- **Reserve/commit hard caps** (atomic Lua); soft budgets with bounded overshoot; refunds on completion; budgets at org/workspace/project/key.
- Per-provider cost functions + **golden usage fixtures** (regression-tested inclusion semantics); `stream_options.include_usage` injection/stripping.
- OTel GenAI emitters (spans + metrics), **async bounded drop-oldest export**, tail-sampling, content-OFF default, credential scrubber (always-on).
- Native UI: live/recent ops dashboards + budget views from Postgres/Redis.

**Done when:** a budget-exceeding burst of concurrent streams is rejected without breaching the cap; traces/metrics land in an external OTel backend with correct token/cost attributes; the OTel backend going down doesn't affect proxying or budgets.

---

## M4 — Guardrails, PII & caching

The governance + performance layer.

- Native detection (RE2 regex + secret-scan + entropy + NER) in a worker pool; parallel checks, short-circuit on BLOCK; lifecycle hooks (`pre/post/during/logging`).
- **Streaming windowed guardrails-post**; per-route `buffered` opt-in; reversible-tokenization vault (PHI-grade, per-request scope).
- Provider guardrail plugins (Bedrock Guardrails, Azure Content Safety/Prompt Shields, Azure Language PII).
- Two-tier cache: exact-hash + semantic (scope-partitioned keys, PII/secret exclusion), cache-control headers + `cache-status` response header.

**Done when:** PII is masked bidirectionally on streamed responses without buffering the whole body; a repeated request served from exact cache with `cache-status: HIT` and zero spend; semantic cache opt-in works and is correctly partitioned by principal.

**Delivered:** `@gulley/guardrails` — native detector (bounded/ReDoS-safe regex + secret-prefix scan + Shannon-entropy catch-all; Luhn-validated cards; overlap resolution), per-request reversible tokenization vault, windowed streaming primitives (`StreamingScanner` audit, `StreamingReplacer` detokenize), and a `GuardrailEngine` with **audit** (default) / **block** / **mask** / **redact** policies per direction + a `GuardrailPlugin` seam. `@gulley/cache` — scope-partitioned exact keys (volatile-field-stripped canonicalization) + a semantic tier (`EmbeddingProvider` + pluggable `VectorIndex`); in-memory stores for CI, **pgvector the prod default** (+ Postgres exact, Redis exact, Redis-Stack vector adapters in `@gulley/storage`; migration 0003 adds `CREATE EXTENSION vector` + an HNSW cosine index). Gateway wires guardrails-pre (403 on block, tokenize-on-mask + response detokenize), a pre-budget cache lookup (a hit is $0 and never touches an upstream), streaming output audit, and buffered output enforcement for non-streamed responses; telemetry gains `gulley.cache.status` + `gulley.guardrail.*` attributes. **Live-validated** (pennies): `cache:check` (exact + semantic hits via real OpenAI embeddings against real Anthropic), `guardrail:check` (audit passthrough / 403 block / mask-reaches-upstream + client-side detokenize, all real Anthropic), `bedrock-guardrail:check` (real Bedrock `ApplyGuardrail`). **Scope note:** streaming **output** guardrails are audit-only; block/redact enforcement applies to non-streamed/buffered responses. RE2 is a documented seam for operator-supplied custom regexes (built-ins are already linear-time). Streaming _input_ masking is full (request body is available whole).

---

## M5 — Control-plane depth, OAuth broker & config/GitOps

Make it administrable and auditable.

- Full admin UI: orgs/workspaces/projects, users/roles, virtual keys, providers/credentials, routes/policies, budgets, rate limits, guardrails.
- **OAuth broker** — device flow + auth-code/PKCE (S256), Entra-backed, short-lived tokens, refresh with reuse-detection, revoke on deprovision.
- Config ↔ versioned YAML serialization (canonical, optimistic concurrency, plan/dry-run diff, drift-detection report); YAML apply through the same audit/RBAC path.
- **SOC 2 hardening:** S3 Object Lock WORM audit sink + chain verification; no-content / no-credential modes gated at every sink; SSRF lockdown; split KMS keys.

**Done when:** an admin configures a full routing+policy setup in the UI, exports it to YAML, and re-applies it via GitOps with an audit trail; a developer authenticates a harness via the OAuth broker; audit rows are tamper-evident and mirrored to WORM storage.

---

## M6 — Infrastructure, CI parity & release hardening

Production on AWS.

- Terraform modules (`network`/`data`/`security`/`compute`/`edge`/`observability`) + `dev` (single-AZ) and `prod` (multi-AZ) root stacks.
- ECS Fargate + ALB **SSE-tuned** (idle ≥300s, deregistration delay, fast drain), autoscaling on connection-count + event-loop-lag, warm-readiness gating.
- Aurora Serverless v2, Redis×3, VPC interface endpoints, Bedrock cross-account assume-role with `ExternalId` + scoped session policy.
- GH Actions + Azure Pipelines at parity via `ci/`; image to ECR; SBOM + image/dep scanning; `workflow_dispatch`-only dependency-bump workflow (single grouped PR — no scheduled automation).
- Full security-review pass (the M1–M5 fuzz/guard tests as gates), load test of the streaming hot path, runbook + docs.

**Done when:** `terraform apply` stands up a working multi-AZ prod environment serving streamed traffic through the ALB; both CIs deploy identically; the security-review checklist passes.

---

## Post-GA seams (not v1)

Multi-tenant activation, HIPAA/FedRAMP/EU-residency full impl, first-class client embeddings endpoint, multimodal/batch first-class handling, semantic routing / contextual grounding, multi-region active/active.
