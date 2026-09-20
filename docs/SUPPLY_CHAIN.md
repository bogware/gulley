# Supply-chain security

Every released image carries three artifacts, produced by the shared
`ci/build-image.sh` (so GitHub Actions and Azure DevOps can't drift):

1. **SBOM** — a software bill of materials, attached to the image as an
   attestation (`docker buildx --sbom=true`).
2. **SLSA provenance** — how/where the image was built, attached as an attestation
   (`--provenance=true`).
3. **cosign signature** — a keyless signature over the image **digest** (not a
   mutable tag), with the signing identity being the CI's OIDC token and the
   signature transparency-logged in Rekor.

The image is also scanned with Trivy (build fails on fixable HIGH/CRITICAL),
**before** any push — to GHCR and to ECR alike — with no skip-dirs and no ignore
file.

### The runtime image

The API image is **distroless** (`gcr.io/distroless/nodejs22-debian12:nonroot`):
`node` is the entrypoint and there is no shell, package manager, or build
toolchain in it. At build time `scripts/bundle.mjs` (esbuild) bundles every
`@gulley/*` workspace package into `dist/gateway/main.mjs`,
`dist/control-api/main.mjs`, `dist/control-api/migrate.mjs`,
`dist/control-api/audit-verify.mjs` and `dist/gateway/doctor.mjs`, stamping the
version and git sha in (`/health`, `gulley_build_info`, OTel `service.version`,
every log line). Third-party packages are installed **production-only** and
hoisted next to `dist/`; `tsx`, esbuild, vitest, drizzle-kit and PGlite never
enter the runtime. The SQL migrations travel with the image (`dist/migrations`)
so the migrate entry and the schema-version readiness probe read the same set.

The console image is Next's standalone server on the same distroless base.

## The public image (GHCR)

The public release image is multi-arch (`linux/amd64` + `linux/arm64`) and lives at
`ghcr.io/bogware/gulley`, built and signed by `.github/workflows/release.yml` on a
`v*` tag:

```bash
docker pull ghcr.io/bogware/gulley:v0.3.0     # or :latest
```

Verify the signature and inspect the attestations by digest before running it:

```bash
IMAGE=ghcr.io/bogware/gulley:v0.3.0
DIGEST="ghcr.io/bogware/gulley@$(docker buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}')"

# 1) Signature: assert it was signed by THIS repo's release workflow via GitHub OIDC.
cosign verify \
  --certificate-identity-regexp '^https://github.com/bogware/gulley/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$DIGEST"

# 2) SBOM + SLSA provenance attestations (attached by buildx).
docker buildx imagetools inspect "$DIGEST" --format '{{ json .SBOM }}'
docker buildx imagetools inspect "$DIGEST" --format '{{ json .Provenance }}'
```

Pin the identity to `bogware/gulley` so a signature from any other repo/workflow is
rejected — the basis for a cluster admission policy that only runs images this
pipeline built and signed.

## Verifying a deployment

Before (or in admission control for) a deploy, verify the signature and inspect
the attestations by digest:

```bash
# Resolve the digest you intend to run.
DIGEST=123.dkr.ecr.us-east-1.amazonaws.com/gulley-prod@sha256:...

# 1) Signature: assert it was signed by THIS repo's release workflow via GitHub OIDC.
cosign verify \
  --certificate-identity-regexp 'https://github.com/<org>/<repo>/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$DIGEST"

# 2) SBOM + provenance attestations.
cosign download sbom "$DIGEST"
cosign verify-attestation --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/<org>/<repo>/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$DIGEST"
```

Pin the identity to your org/repo/workflow so a signature from any other identity
is rejected. This is what lets a cluster admission policy (e.g. Kyverno /
sigstore-policy-controller) require that only images built and signed by this
pipeline can run.

## Local builds

`SKIP_SIGN=1 bash ci/build-image.sh` builds and pushes without signing (there is
no OIDC identity locally). Never deploy an unsigned image to production.

## Dependency updates

Dependency bumps are **manual and grouped** (`workflow_dispatch` only — no
scheduled Dependabot/renovate), by policy. Each bump is a normal reviewed PR that
passes the full gate, keeping the SBOM's provenance auditable.
