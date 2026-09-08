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
  Azure PR pipeline) run `verify` / `hotpath` / `terraform` on `ubuntu-latest`.
  They carry a read-only `GITHUB_TOKEN` and reference no secrets, so a malicious
  fork PR gains nothing. **Never move a `pull_request`-triggered job to
  self-hosted** — the top of `ci.yml` says so, keep it that way.
- **Trusted jobs only, for self-hosted.** `release.yml` and the Azure release
  pipeline are `workflow_dispatch` / tag / `trigger: none` only — a fork PR can
  never reach them. Every credentialed job is gated with
  `if: github.repository == 'bogware/gulley'` so it no-ops on forks. These are the
  only jobs that may use a self-hosted runner.

## If you register self-hosted runners

1. **Register at the repository level**, not org/enterprise — an org runner is
   reachable by every repo. If you must use an org runner group, restrict the
   group to selected repositories.
2. **Use ephemeral, single-job runners** (e.g. actions-runner-controller in
   `ephemeral` mode, one job per fresh VM/container) so nothing persists between
   jobs.
3. **Network-isolate** the runner: no standing access to production, no
   long-lived cloud credentials on the host (use short-lived OIDC federation, as
   `release.yml` already does).
4. **Never use a runner label a fork could request** from a `pull_request` job.

## Repo settings (apply these too)

Workflow files can't express everything — set these in GitHub repo settings:

- **Actions → Fork pull request workflows**: *Require approval for all outside
  collaborators* (or for all external contributors).
- **Actions → Workflow permissions**: default `GITHUB_TOKEN` = **read-only**;
  require approval for it to create/approve PRs.
- **Code security**: enable *secret scanning* and *push protection*.
- **Branch protection** on `main`: require a PR + review, require status checks
  (`verify`, `hotpath`, `terraform`), no force-push, no deletion.

## Supply chain

- Every third-party action is **pinned to a full commit SHA** (with the version
  in a trailing comment). Update them deliberately, never by moving a tag.
- Dependency bumps are manual and grouped (`dependency-bump.yml`, `workflow_dispatch`
  only) — there is intentionally **no** scheduled Dependabot/renovate.
- Release images are built with SBOM + provenance and **cosign-signed**; the
  image is Trivy-scanned and fails on HIGH/CRITICAL.
