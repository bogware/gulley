<h1 align="center">Gulley</h1>

<p align="center"><strong>An enterprise-grade, self-hostable LLM gateway.</strong></p>

<p align="center">
  One container in front of every LLM provider your organization uses — adding routing,
  cost control, observability, caching, guardrails, access control, and audit,
  without changing a line of application code.
</p>

---

> **Status:** early development (milestone **M0 — scaffold**). See [`docs/ROADMAP.md`](docs/ROADMAP.md).

Gulley is **Claude-first** (the Anthropic Messages schema is its canonical internal
model) and **drop-in**: point Claude Code, Codex, or any custom harness at Gulley by
changing a base URL and everything just works — while you gain a control plane over
every request.

## Why Gulley

- **Multi-provider** — OpenAI, Anthropic (API + Enterprise), AWS Bedrock, Azure AI Foundry, behind one surface.
- **Native passthrough + normalized routing** — full-fidelity per-provider APIs _and_ a cross-provider layer for routing, load-balancing, and failover.
- **Real governance** — RBAC, virtual keys, budgets with hard caps, PII/data masking, guardrails, and a tamper-evident audit trail. Governance is a core primitive, not an upsell.
- **Observability without lock-in** — emits OpenTelemetry (GenAI semantic conventions) to _your_ backend; enforces cost/rate limits locally.
- **Runs where you run** — a single container for AWS ECS Fargate, provisioned by Terraform.

## Architecture

The full design — request pipeline, provider abstraction, auth model, data model, AWS
topology, and a concrete integration-spec appendix — lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
apps/gateway       data plane: the streaming proxy + request pipeline
apps/control-api   control plane: orgs, keys, routes, policies, OAuth broker
apps/web           admin UI (Next.js)
packages/*         core, providers, auth, pipeline, guardrails, cost, config, telemetry, storage, sdk
infra/terraform    AWS infrastructure as code
ci/                shared build/test/scan/deploy scripts (called by both CIs)
```

## Quick start (development)

Prerequisites: **Node ≥ 22** (via [corepack](https://nodejs.org/api/corepack.html)), **Docker**, **Terraform ≥ 1.9**.

```bash
corepack enable                 # activates pnpm from package.json's packageManager
pnpm install
cp .env.example .env            # local defaults; no real secrets
docker compose up -d            # postgres + redis (cache/counters/vector)
pnpm dev                        # gateway, control-api, and web
```

Health checks:

```bash
curl localhost:8080/health      # gateway (data plane)
curl localhost:8081/health      # control-api (control plane)
```

## Common tasks

| Command            | What it does                                    |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | Run all apps in watch mode                      |
| `pnpm build`       | Build every package/app                         |
| `pnpm typecheck`   | Type-check the whole workspace                  |
| `pnpm lint`        | Lint (ESLint + Prettier)                        |
| `pnpm test`        | Run unit/integration tests (Vitest)             |
| `pnpm db:generate` | Generate SQL migrations from the Drizzle schema |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) — sign your
commits with `git commit -s`.

## License

[Apache License 2.0](LICENSE). Copyright 2026 The Gulley Authors.
