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
**before** the public multi-arch push.

### Documented scanning exceptions

The runtime currently executes TypeScript via `tsx`, so the image ships the full
dev/build/install toolchain in `node_modules`. Two narrow, documented exceptions
keep the gate meaningful without failing on unreachable build-tool CVEs:

1. **esbuild transpiler binary** — excluded via `--skip-dirs '**/@esbuild'`. `tsx`
   bundles esbuild's Go binary purely to transpile local source; its embedded
   Go-stdlib CVEs (`net/http`, `net/mail`, `crypto/tls` DoS/XSS) are unreachable
   (no server, no untrusted parsing).
2. **`.trivyignore`** (repo root) — a per-CVE list for the shipped dev/build/
   install toolchain (vitest, vite, tar, pacote, sigstore, js-yaml, picomatch,
   brace-expansion, ip-address), each verified _not_ in the runtime dependency
   graph (`pnpm why --prod`), plus one runtime dependency whose vulnerable path is
   unreachable (`@opentelemetry/propagator-jaeger` — the Jaeger propagator is
   never instantiated). Every entry is commented with its justification.

**OS packages and genuine runtime libraries are still scanned strictly** (the
build fails on any fixable HIGH/CRITICAL). The durable fix that removes the need
for these exceptions — pre-bundling to JS and running plain `node` on a distroless
base, so `tsx`/esbuild and the toolchain are absent from the runtime — is a
tracked follow-up.

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
