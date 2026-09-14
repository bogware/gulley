<h1 align="center">Gulley</h1>

<p align="center"><strong>One gate every model request rides through.</strong></p>

<p align="center">
  A self-hostable, enterprise-grade LLM gateway: a single container in front of every
  provider your outfit uses — adding routing, cost control, caching, guardrails, access
  control, and a tamper-evident audit trail, without changing a line of application code.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2F5D8C.svg"></a>
  <img alt="Self-hostable" src="https://img.shields.io/badge/self--hostable-yes-2F5D8C.svg">
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A522-2F5D8C.svg">
  <a href="https://developercertificate.org/"><img alt="DCO" src="https://img.shields.io/badge/commits-DCO%20signed-2F5D8C.svg"></a>
</p>

<p align="center"><em>Out on the model frontier, traffic rides in from every vendor at once.
Gulley is the gate at the pass — it checks the papers, tallies the toll, keeps the ledger,
and remembers exactly who rode through.</em></p>

<p align="center">
  <img src="docs/images/console-overview.jpg" alt="Gulley admin console — overview dashboard" width="900">
</p>

---

**One control plane over both Claude Code _and_ Codex.** Anthropic's and OpenAI's own
gateways each govern only their own agent, with after-the-fact, 30-day logs. Gulley is
the single **in-line, tamper-evident** plane over both — plus Bedrock, Vertex, and Azure —
with cross-vendor DLP, tool-call policy, hard budgets, and a WORM audit no single-vendor
tool can match. It is **Claude-first** (the Anthropic Messages schema is its canonical
internal model) and **drop-in**: point Claude Code, Codex, or any custom harness at Gulley
by changing a base URL, and everything just works — while you gain governance, cost
control, and audit over every request.

## Why Gulley

- **Multi-provider, one surface** — Anthropic (API + Enterprise), OpenAI, AWS Bedrock, Azure AI Foundry, Google Gemini/Vertex, any OpenAI-compatible backend (Groq, Mistral, Together, …), and local runtimes (Ollama, vLLM, LM Studio). Native full-fidelity passthrough _and_ a cross-provider layer for routing, load-balancing, failover, and same-model arbitrage.
- **Governance, all open** — RBAC, virtual keys, budgets with hard caps, PII/secret masking, guardrails, and a tamper-evident (hash-chained + S3 Object Lock WORM, KMS-signed, externally anchored) audit trail. Every governance feature is in the Apache-2.0 core — not paywalled behind an "enterprise" edition.
- **Coding-agent aware** — governs and _attributes_ the traffic Claude Code and Codex actually generate; in-stream (not buffered) source-code / secret DLP; the prompt cache the big cacheable prefixes depend on is metered, so you can see the dollars it saves.
- **Enterprise identity** — Microsoft **Entra (Azure AD) SSO** for the console, JWT auth for the data plane, App-Role / group → RBAC, SCIM provisioning, and Graph-backed revoke-on-deprovision. See [`docs/ENTRA_SETUP.md`](docs/ENTRA_SETUP.md).
- **Observability without lock-in** — emits OpenTelemetry (GenAI semantic conventions) to _your_ backend; enforces cost/rate limits locally; a Prometheus endpoint and a batteries-included admin console.
- **Runs where you run** — one container for AWS ECS Fargate (a single adaptable [Terraform module](infra/terraform)), Kubernetes ([Helm](deploy/helm)), or a [docker-compose](deploy/docker-compose.prod.yml) self-host.

## The console

A batteries-included Next.js admin plane — observe spend and traffic, browse the request
log, walk the tamper-evident audit chain, manage identity and routing, and edit config
as GitOps.

<table>
  <tr>
    <td width="50%"><img src="docs/images/console-logs.jpg" alt="Request log browser"><br><sub><b>Request logs</b> — every call, keyset-paginated, with latency and cost.</sub></td>
    <td width="50%"><img src="docs/images/console-compliance.jpg" alt="Compliance and WORM"><br><sub><b>Compliance & WORM</b> — hash-chained audit, signed attestation, evidence bundle.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/console-analytics.jpg" alt="Analytics"><br><sub><b>Analytics</b> — cost / tokens / requests by provider, model, or workspace.</sub></td>
    <td width="50%" valign="top"><br><b>Also in the console:</b> FinOps chargeback &amp; shadow-spend, guardrails, budgets &amp; rate limits, virtual keys &amp; onboarding, OAuth/Entra identity, providers, prompts, eval rollouts, and a live config editor.</td>
  </tr>
</table>

## Architecture

The full design — request pipeline, provider abstraction, auth model, data model, AWS
topology, and a concrete integration-spec appendix — lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); delivered capabilities are tracked in the
[CHANGELOG](CHANGELOG.md).

```
apps/gateway       data plane: the streaming proxy + request pipeline
apps/control-api   control plane: orgs, keys, routes, policies, OAuth/OIDC, SCIM
apps/web           admin console (Next.js)
packages/*         core, providers, routing, auth, rbac, budget, cost, catalog, cache,
                   guardrails, pipeline, config, storage, telemetry, oauth, oidc, cel,
                   crypto, worm, redact, egress, control-client
infra/terraform    one adaptable AWS module (test/prod tiers) — see INSTALL.md
deploy/            Helm chart + docker-compose self-host
```

## Quick start (development)

Prerequisites: **Node ≥ 22** (via [corepack](https://nodejs.org/api/corepack.html)), **Docker**.

```bash
corepack enable                 # activates pnpm from package.json's packageManager
pnpm install
cp .env.example .env            # local defaults; no real secrets
docker compose up -d            # postgres (pgvector) + redis (cache/counters/vector)
pnpm --filter @gulley/storage db:migrate
pnpm dev                        # gateway (:8080), control-api (:8081), web (:3000)
```

Point any Anthropic-Messages client at the gateway and send a request with a virtual key:

```bash
# mint a key (prints a gk_ token once)
DATABASE_URL=postgres://gulley:gulley@localhost:5432/gulley GULLEY_KEY_PEPPER=dev-pepper-1234567890 \
  pnpm --filter @gulley/control-api seed --name dev

export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=gk_...        # the printed token
# now Claude Code, Codex, or curl all flow through Gulley
```

Prefer short-lived, identity-bound tokens over static keys? Turn on the OAuth broker
(`OAUTH_BROKER_ENABLED=true` on both apps), register a client in the console, and have
developers run `pnpm gulley login` — Claude Code and Codex then fetch tokens through
`gulley token`. See [`docs/HARNESS_OAUTH.md`](docs/HARNESS_OAUTH.md).

## Deploy

The release image is published multi-arch (amd64 + arm64) at
**`ghcr.io/bogware/gulley`**, cosign-signed with an SBOM + SLSA provenance
(`docker pull ghcr.io/bogware/gulley` — [how to verify](docs/SUPPLY_CHAIN.md)).

- **AWS (Terraform)** — one adaptable module, `test` and `prod` tiers, with an exact
  agent/operator runbook: [`infra/terraform/INSTALL.md`](infra/terraform/INSTALL.md).
- **Kubernetes** — [`deploy/helm/gulley`](deploy/helm/gulley).
- **Single host** — [`deploy/docker-compose.prod.yml`](deploy/docker-compose.prod.yml).
- **Identity** — wire Microsoft Entra SSO + SCIM: [`docs/ENTRA_SETUP.md`](docs/ENTRA_SETUP.md).
- **Air-gapped** — a no-egress posture: [`docs/AIR_GAPPED.md`](docs/AIR_GAPPED.md).

## Common tasks

| Command                            | What it does                                       |
| ---------------------------------- | -------------------------------------------------- |
| `pnpm dev`                         | Run all apps in watch mode                         |
| `bash ci/verify.sh`                | The full local gate (format/lint/types/test/build) |
| `pnpm test`                        | Unit/integration tests (Vitest)                    |
| `pnpm db:generate`                 | Generate SQL migrations from the schema            |
| `pnpm --filter @gulley/<pkg> test` | Test one package                                   |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) — sign your commits
with `git commit -s`. Report vulnerabilities privately via
[Security Advisories](../../security/advisories/new); see [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 The Gulley Authors.
