# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-08

First public release. Gulley is a self-hostable, enterprise LLM gateway: one
container fronting every major provider that adds routing, cost/budget
enforcement, caching, guardrails, RBAC, and a tamper-evident audit trail behind a
single base-URL change.

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
- **Compliance.** Hash-chained audit trail with S3 Object Lock (WORM) mirroring,
  KMS-asymmetric signing, external anchoring, downloadable evidence bundles, SIEM
  export, BYOK envelope encryption with crypto-shred, data-residency/ZDR
  enforcement, and an air-gapped posture.
- **Admin console.** Next.js control plane for observability, logs, routing, config
  (GitOps editor), FinOps, identity, and compliance.
- **Deploy.** A single adaptable Terraform module (test/prod tiers) for AWS
  (ECS Fargate, Aurora Serverless v2, ElastiCache, ALB, KMS, Secrets Manager),
  a Helm chart, and a docker-compose self-host.

[Unreleased]: https://github.com/bogware/gulley/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bogware/gulley/releases/tag/v0.1.0
