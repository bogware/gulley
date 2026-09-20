#!/usr/bin/env bash
# Build the single monorepo image (runs either app; the ECS task def / compose
# command picks which) with SBOM + provenance attestations and a keyless cosign
# signature over the immutable digest. Shared by both CIs so image builds never drift.
#
# Targets ANY OCI registry via IMAGE (the repo ref, no tag). Defaults to
# ECR_REPOSITORY for backward-compat with the AWS deploy path.
#   # public multi-arch image -> GHCR (login handled by the workflow):
#   IMAGE=ghcr.io/bogware/gulley IMAGE_TAG=v0.3.0 TAG_LATEST=1 \
#     PLATFORMS=linux/amd64,linux/arm64 bash ci/build-image.sh
#   # private image -> ECR (ARM64 Fargate):
#   ECR_REPOSITORY=<acct>.dkr.ecr.<region>.amazonaws.com/gulley-prod \
#     IMAGE_TAG=... AWS_REGION=... bash ci/build-image.sh
#
# Login: for an ECR target the script performs the `aws ecr get-login-password`
# dance (needs AWS_REGION). For any OTHER registry (e.g. ghcr.io) the CALLER must
# `docker login` first — the GitHub release workflow uses docker/login-action with
# GITHUB_TOKEN. Signing uses ambient OIDC (the job needs id-token: write); set
# SKIP_SIGN=1 for a local build with no OIDC identity.
set -euo pipefail

IMAGE="${IMAGE:-${ECR_REPOSITORY:-}}"
: "${IMAGE:?IMAGE (or ECR_REPOSITORY) is required — the image repo ref without a tag}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
PLATFORMS="${PLATFORMS:-linux/arm64}"   # ECR/Fargate default; GHCR overrides to multi-arch.
DOCKERFILE="${DOCKERFILE:-apps/gateway/Dockerfile}"

REGISTRY="${IMAGE%%/*}"

# ECR needs a token dance; other registries are assumed pre-authenticated by the caller.
if [[ "$REGISTRY" == *.dkr.ecr.*.amazonaws.com ]]; then
  : "${AWS_REGION:?AWS_REGION is required for an ECR target}"
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"
fi

tags=(--tag "${IMAGE}:${IMAGE_TAG}")
if [[ "${TAG_LATEST:-0}" == "1" ]]; then
  tags+=(--tag "${IMAGE}:latest")
fi

META="$(mktemp)"
trap 'rm -f "$META"' EXIT

# Stamp the build: the tag (or GULLEY_VERSION) + the git sha land in /health,
# gulley_build_info, OTel service.version and every log line.
BUILD_VERSION="${GULLEY_VERSION:-$IMAGE_TAG}"
BUILD_SHA="${GULLEY_BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

docker buildx build \
  --platform "$PLATFORMS" \
  --file "$DOCKERFILE" \
  --build-arg "GULLEY_VERSION=${BUILD_VERSION}" \
  --build-arg "GULLEY_BUILD_SHA=${BUILD_SHA}" \
  "${tags[@]}" \
  --provenance=true \
  --sbom=true \
  --metadata-file "$META" \
  --push \
  .

# Sign the immutable digest (never a mutable tag), so a re-tag can't shadow the
# signed image. cosign v2 is keyless by default: the signature identity is the CI's
# OIDC token, transparency-logged in Rekor.
DIGEST="$(jq -r '."containerimage.digest"' "$META")"
IMAGE_REF="${IMAGE}@${DIGEST}"
echo "pushed ${IMAGE}:${IMAGE_TAG} (${DIGEST})"

# Surface the digest/ref to the workflow (image scan, release-notes job) when in CI.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "digest=${DIGEST}"
    echo "image_ref=${IMAGE_REF}"
  } >>"$GITHUB_OUTPUT"
fi

if [[ "${SKIP_SIGN:-0}" == "1" ]]; then
  echo "SKIP_SIGN=1 — not signing"
  exit 0
fi
cosign sign --yes "$IMAGE_REF"
echo "signed ${IMAGE_REF}"
