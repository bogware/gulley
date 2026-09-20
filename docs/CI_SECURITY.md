# CI/CD security posture

Gulley is a public repository. This document explains how CI is hardened and, if
you run **self-hosted runners**, how to do it safely.

## The threat

On a public repo, anyone can open a pull request from a fork. A `pull_request`
workflow that checks out and runs that PR's code (`pnpm install`, tests, builds)
is **executing untrusted code by design**. If that job runs on a **self-hosted
runner**, the attacker gets code execution on your infrastructure — a path to
your secrets, your network, and lateral movement. This is the single most
important rule below.

## Posture: split runners

- **Fork-PR CI runs only on GitHub/Microsoft-hosted runners.** `ci.yml` (and the
  Azure PR pipeline `.azuredevops/azure-pipelines.yml`) run `verify` / `hotpath` /
  `terraform` / `deploy-manifests` on `ubuntu-latest`, each a thin call into the
  shared `ci/*.sh` scripts. They carry a read-only `GITHUB_TOKEN` and reference no
  secrets, so a malicious fork PR gains nothing. `codeql.yml` (static analysis on
  push to `main` and on PRs) is GitHub-hosted too and elevates only
  `security-events: write`. **Never move a `pull_request`-triggered job to
  self-hosted** — the top of `ci.yml` says so, keep it that way.
- **Trusted jobs only, for self-hosted.** `release.yml` (tag `v*` or
  `workflow_dispatch` with a required `image_tag`), `dependency-bump.yml`
  (`workflow_dispatch`, holds a write token) and the Azure release pipeline
  (`trigger: none`, `pr: none`) can never be reached by a fork PR. Every
  credentialed job is gated with `if: github.repository == 'bogware/gulley'` so it
  no-ops on forks. These are the only jobs that may use a self-hosted runner.
- **No scheduled triggers anywhere.** Nothing runs unattended: no cron in CI,
  release, CodeQL, or dependency updates.

## If you register self-hosted runners

1. **Register at the repository level**, not org/enterprise — an org runner is
   reachable by every repo. If you must use an org runner group, restrict the
   group to selected repositories.
2. **Use ephemeral, single-job runners** (e.g. actions-runner-controller in
   `ephemeral` mode, one job per fresh VM/container) so nothing persists between
   jobs.
3. **Network-isolate** the runner: no standing access to production, no
   long-lived cloud credentials on the host (use short-lived OIDC federation, as
   `release.yml` already does for AWS and for cosign).
4. **Never use a runner label a fork could request** from a `pull_request` job.

## Repo settings (apply these too)

Workflow files can't express everything — set these in GitHub repo settings.
`bash ci/harden-public-repo.sh` (needs an admin-authenticated `gh`) applies the
read-only token default, secret scanning + push protection, and the `main` branch
protection in one go; run it once after the repository is public. The fork-PR
approval toggle is UI-only:

- **Actions → Fork pull request workflows**: _Require approval for all outside
  collaborators_ (or for all external contributors).
- **Actions → Workflow permissions**: default `GITHUB_TOKEN` = **read-only**;
  require approval for it to create/approve PRs.
- **Code security**: enable _secret scanning_ and _push protection_. CodeQL
  results land under _Security → Code scanning_.
- **Branch protection** on `main`: require a PR + review, require the CI status
  checks (`verify`, `hotpath`, `terraform`; add `deploy-manifests`), no
  force-push, no deletion.

## Supply chain

- Every third-party action is **pinned to a full commit SHA** (with the version
  in a trailing comment). Update them deliberately, never by moving a tag. The
  Azure pipelines pin their downloaded tools (Terraform, Helm, cosign, Trivy) to
  release versions and checksum-verify cosign.
- Dependency bumps are manual and grouped (`dependency-bump.yml`, `workflow_dispatch`
  only) — there is intentionally **no** scheduled Dependabot/renovate.
- Release images are distroless, built with SBOM + provenance, **cosign-signed**
  by digest, and Trivy-scanned **before** any push (fails on fixable
  HIGH/CRITICAL; there is no ignore file). Details and verification commands:
  [`SUPPLY_CHAIN.md`](SUPPLY_CHAIN.md).
