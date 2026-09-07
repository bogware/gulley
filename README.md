<h1 align="center">Gulley</h1>

<p align="center"><strong>An enterprise-grade, self-hostable LLM gateway.</strong></p>

<p align="center">
  One container in front of every LLM provider your organization uses — adding routing,
  cost control, observability, caching, guardrails, access control, and audit,
  without changing a line of application code.
</p>

---

> **Status:** actively developed and Apache-2.0 open source. The core data plane,
> governance/RBAC/audit/WORM, budgets, caching, guardrails + in-stream enforcement,
> resilience/routing, config hot-reload, and smart classification routing are
> delivered; work now focuses on the cross-vendor coding-agent control plane (see
> [`docs/WAVE_A_PLAN.md`](docs/WAVE_A_PLAN.md)). [`docs/ROADMAP.md`](docs/ROADMAP.md)
> and [`docs/AGENTGATEWAY_PORT.md`](docs/AGENTGATEWAY_PORT.md) are the source of truth
> for the current state — don't trust milestone numbers in prose.

**One control plane over both Claude Code _and_ Codex.** Anthropic's and OpenAI's own
gateways each govern only their own agent, with after-the-fact, 30-day compliance
logs. Gulley is the single **in-line, tamper-evident** plane over both (plus Bedrock,
Vertex, and Azure) — cross-vendor DLP, tool-call policy, hard budgets, and a WORM
audit no single-vendor tool can match. It is **Claude-first** (the Anthropic Messages
schema is its canonical internal model) and **drop-in**: point Claude Code, Codex, or
any custom harness at Gulley by changing a base URL and everything just works — while
you gain governance, cost control, and audit over every request.

## Why Gulley

- **Multi-provider** — Anthropic (API + Enterprise), OpenAI, AWS Bedrock, Azure AI Foundry, Google Gemini/Vertex, any OpenAI-compatible backend (Groq, Mistral, Together, …), and local runtimes (Ollama, vLLM, LM Studio, …), behind one surface.
- **Native passthrough + normalized routing** — full-fidelity per-provider APIs _and_ a cross-provider layer for routing, load-balancing, and failover.
- **Real governance, all open** — RBAC, virtual keys, budgets with hard caps, PII/data masking, guardrails, and a tamper-evident (hash-chained + S3 Object Lock) audit trail. Every governance feature is in the Apache-2.0 core, not paywalled behind an "enterprise" edition.
- **Coding-agent aware** — governs and attributes the traffic Claude Code and Codex actually generate; in-stream (not buffered) source-code / secret DLP; the prompt cache the big cacheable prefixes depend on is metered so you can see the dollars it saves.
- **Observability without lock-in** — emits OpenTelemetry (GenAI semantic conventions) to _your_ backend; enforces cost/rate limits locally.
- **Runs where you run** — a single container for AWS ECS Fargate (Terraform) or Kubernetes (Helm); self-host it entirely.

## Architecture

The full design — request pipeline, provider abstraction, auth model, data model, AWS
topology, and a concrete integration-spec appendix — lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
apps/gateway       data plane: the streaming proxy + request pipeline
apps/control-api   control plane: orgs, keys, routes, policies, OAuth broker
apps/web           admin UI (Next.js)
packages/*         core, providers, routing, auth, rbac, budget, cost, catalog, cache,
                   guardrails, pipeline, config, storage, telemetry, metrics, ratelimit,
                   oauth, oidc, cel, crypto, worm, redact, egress, http-edge
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
