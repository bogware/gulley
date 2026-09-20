# Supply-chain security

Every released image carries three artifacts, produced by the shared
`ci/build-image.sh` (so GitHub Actions and Azure DevOps can't drift):

1. **SBOM** — a software bill of materials, attached to the image as an
   attestation (`docker buildx --sbom=true`).
2. **SLSA provenance** — how/where the image was built, attached as an attestation
   (`--provenance=true`).
3. **cosign signature** — a keyless signature over the image **digest** (not a
   mutable tag), with the signing identity being the CI's OIDC token and the
   signature transparency-logged in Rekor. The signed digest is the image index,
   which pins the attestation manifests, so they cannot be swapped underneath it.

The image is also scanned with Trivy (build fails on fixable HIGH/CRITICAL),
**before** any push — to GHCR and to ECR alike — with no skip-dirs and no ignore
file.

### The runtime image

The API image is **distroless** (`gcr.io/distroless/nodejs22-debian12:nonroot`,
built by `apps/gateway/Dockerfile`): `node` is the entrypoint and there is no shell,
package manager, or build toolchain in it. At build time `scripts/bundle.mjs`
(esbuild) bundles every `@gulley/*` workspace package into `dist/gateway/main.mjs`,
`dist/gateway/doctor.mjs`, `dist/control-api/main.mjs`,
`dist/control-api/migrate.mjs` and `dist/control-api/audit-verify.mjs`, stamping the
version and git sha in from the `GULLEY_VERSION` / `GULLEY_BUILD_SHA` build args
(`ci/build-image.sh` derives them from the image tag and `git rev-parse`; they
surface in `/health`, `gulley_build_info`, OTel `service.version`, and every log
line). Third-party packages are installed **production-only, per app**
(`pnpm deploy`) next to each bundled entry; `tsx`, esbuild, vitest, drizzle-kit and
PGlite never enter the runtime. The SQL migrations travel with the image
(`dist/migrations`, `GULLEY_MIGRATIONS_DIR`) so the migrate entry and the
schema-version readiness probe (`DB_SCHEMA_CHECK`) read the same set.

The console image (`ghcr.io/bogware/gulley-web`, `apps/web/Dockerfile`) is Next's
standalone server on the same distroless base, published through the same
scan-then-sign gate.

## The public images (GHCR)

The public release images are multi-arch (`linux/amd64` + `linux/arm64`) and live at
`ghcr.io/bogware/gulley` (API) and `ghcr.io/bogware/gulley-web` (console). They are
built and signed by `.github/workflows/release.yml` on a `v*` tag push — which also
moves `:latest` and publishes a GitHub Release whose notes are the tag's CHANGELOG
section, with the API image's SBOM attached best-effort — or by a manual
`workflow_dispatch` run that must name its `image_tag` (`latest` is refused, so a
stray manual run can never move it):

```bash
docker pull ghcr.io/bogware/gulley:v0.4.0     # or :latest
```

Verify the signature and inspect the attestations by digest before running it:

```bash
IMAGE=ghcr.io/bogware/gulley:v0.4.0
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

## Verifying a private (ECR) deployment

The `ecr` job in `release.yml` is opt-in (it runs only when the repo variable
`ECR_REPOSITORY` is set) and pushes a `linux/arm64` image for Fargate through the same
`ci/build-image.sh`, so the same checks apply — only the identity differs when you
build from your own fork/workflow:

```bash
# Resolve the digest you intend to run.
DIGEST=123.dkr.ecr.us-east-1.amazonaws.com/gulley-prod@sha256:...

# 1) Signature: assert it was signed by YOUR repo's release workflow via GitHub OIDC.
cosign verify \
  --certificate-identity-regexp '^https://github.com/<org>/<repo>/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$DIGEST"

# 2) SBOM + provenance attestations (attached by buildx, read with imagetools).
docker buildx imagetools inspect "$DIGEST" --format '{{ json .SBOM }}'
docker buildx imagetools inspect "$DIGEST" --format '{{ json .Provenance }}'
```

Pin the identity to your org/repo/workflow so a signature from any other identity
is rejected. This is what lets a cluster admission policy (e.g. Kyverno /
sigstore-policy-controller) require that only images built and signed by this
pipeline can run.

## Local builds

`ci/build-image.sh` needs `IMAGE` (the repo ref, no tag) and `IMAGE_TAG`; it logs in
to ECR itself (needs `AWS_REGION`), while any other registry must be logged in first.
`SKIP_SIGN=1` builds and pushes without signing (there is no OIDC identity locally):

```bash
docker login ghcr.io
IMAGE=ghcr.io/<you>/gulley IMAGE_TAG=dev PLATFORMS=linux/amd64 SKIP_SIGN=1 bash ci/build-image.sh
DOCKERFILE=apps/web/Dockerfile IMAGE=ghcr.io/<you>/gulley-web IMAGE_TAG=dev SKIP_SIGN=1 bash ci/build-image.sh
```

For a purely local image (no push), build the Dockerfile directly:

```bash
docker buildx build -f apps/gateway/Dockerfile --load -t gulley:dev \
  --build-arg GULLEY_VERSION=dev --build-arg GULLEY_BUILD_SHA=$(git rev-parse --short HEAD) .
```

Never deploy an unsigned image to production.

## Dependency updates

Dependency bumps are **manual and grouped** (`workflow_dispatch` only — no
scheduled Dependabot/renovate), by policy. Each bump is a normal reviewed PR that
passes the full gate, keeping the SBOM's provenance auditable.
