# Contributing to Gulley

Thanks for your interest in improving Gulley. This document covers how to get set up,
our expectations for changes, and the legal basis for contributions.

## Developer Certificate of Origin (DCO)

Gulley uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) rather than a CLA. By signing off on your commits, you certify that you wrote the
patch or otherwise have the right to submit it under the project's Apache-2.0 license.

Sign off every commit:

```bash
git commit -s -m "Your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. Use your real name
and an email you can be reached at. CI enforces the sign-off.

## Development setup

Prerequisites: **Node ≥ 22** (via corepack), **Docker**, **Terraform ≥ 1.9**.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Or in one shot, the way CI does it: `bash ci/all.sh`.

### Guidelines

- **Keep changes focused.** One logical change per PR.
- **Match the surrounding style.** Prettier + ESLint are the source of truth for formatting.
- **Tests travel with code.** New behavior needs tests; bug fixes need a regression test.
- **Never commit secrets.** Only Secrets Manager ARNs belong in the tree — no provider keys, tokens, or credentials, even in tests or `.env` examples.
- **Respect the architecture.** The request pipeline, provider abstraction, and security invariants in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) are deliberate. If a change works against them, open an issue to discuss first.

## Dependency updates

Dependency bumps are **manual and grouped** — there is no scheduled automation. Run the
`workflow_dispatch`-only dependency workflow (added in a later milestone) to open a single
grouped update PR. Please don't add scheduled Dependabot/renovate configs.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Follow the process in
`SECURITY.md` (added alongside the security-hardening milestone).
