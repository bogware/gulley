# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/bogware/gulley/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bogware/gulley/releases/tag/v0.3.0
