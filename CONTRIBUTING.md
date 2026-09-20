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

Prerequisites: **Node ≥ 22.9** (via corepack, which activates pnpm 9 from
`package.json`), **Docker**. Only for `infra/` changes: **Terraform ≥ 1.6** (CI pins
1.15.8). Only for `deploy/helm` changes: **Helm 3** (`ci/helm-check.sh` skips the
lint/template step without it).

```bash
corepack enable
pnpm install
cp .env.example .env                       # dev defaults; add a provider key to get routes
docker compose up -d                       # postgres (pgvector) + the three role-split redis
pnpm --filter @gulley/control-api migrate  # apply the SQL migrations
pnpm dev                                   # gateway (:8080), control-api (:8081), web (:3000)
```

Every workspace `tsx` script loads the repo-root `.env` itself
(`--env-file-if-exists=../../.env`), so Turborepo's strict env mode (only `NODE_ENV` is
forwarded to tasks) never strips your configuration; a variable exported in the shell
only reaches an app when it is also in `.env` or passed with `pnpm dev --env-mode=loose`.
Every env knob is declared in `apps/gateway/src/config.ts` /
`apps/control-api/src/config.ts` (Zod) and mirrored in `.env.example` — add new ones to
both.

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build        # next build for the console
pnpm bundle       # esbuild-bundle both apps — proves every entry resolves for the image
```

Or in one shot, the way CI does it: `bash ci/verify.sh`. Infra and deploy changes have
their own no-cloud gates: `bash ci/tf-check.sh` (Terraform fmt + validate for
`infra/terraform` and `infra/eks`) and `bash ci/helm-check.sh` (Helm lint/template +
compose structural checks).

### Guidelines

- **Keep changes focused.** One logical change per PR.
- **Match the surrounding style.** Prettier + ESLint are the source of truth for formatting.
- **Tests travel with code.** New behavior needs tests; bug fixes need a regression test.
- **Never commit secrets.** Only Secrets Manager ARNs belong in the tree — no provider keys, tokens, or credentials, even in tests or `.env` examples.
- **Respect the architecture.** The request pipeline, provider abstraction, and security invariants in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) are deliberate. If a change works against them, open an issue to discuss first.
- **Hot-path changes get an adversarial review.** If a change touches the data-plane hot path (`bash ci/hotpath-guard.sh` lists what qualifies), run the adversarial review pass in [`docs/HOTPATH_REVIEW.md`](docs/HOTPATH_REVIEW.md) and add a `Hotpath-Reviewed:` trailer to a commit in the branch — CI runs the guard with `HOTPATH_STRICT=1` and fails without it.

## Dependency updates

Dependency bumps are **manual and grouped** — there is no scheduled automation. Run the
`workflow_dispatch`-only workflow (`.github/workflows/dependency-bump.yml`) to open a
single grouped update PR. Please don't add scheduled Dependabot/renovate configs.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Follow the process in
[`SECURITY.md`](SECURITY.md).
