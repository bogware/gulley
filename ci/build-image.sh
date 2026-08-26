#!/usr/bin/env bash
# Build the single monorepo image (runs either app; the ECS task def picks the
# command) for the ECS task platform and push it to ECR with SBOM + provenance
# attestations, then keyless-sign it with cosign. Shared by both CIs so image
# builds can never drift.
#
# Requires (from the CI's OIDC role): ECR_REPOSITORY, IMAGE_TAG, AWS_REGION.
# Signing uses ambient OIDC (the CI job needs id-token: write). Set SKIP_SIGN=1
# for a local build with no OIDC identity.
set -euo pipefail

: "${ECR_REPOSITORY:?ECR_REPOSITORY is required (e.g. 123.dkr.ecr.us-east-1.amazonaws.com/gulley-prod)}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${AWS_REGION:?AWS_REGION is required}"

REGISTRY="${ECR_REPOSITORY%%/*}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

META="$(mktemp)"
trap 'rm -f "$META"' EXIT

docker buildx build \
  --platform linux/arm64 \
  --file apps/gateway/Dockerfile \
  --tag "${ECR_REPOSITORY}:${IMAGE_TAG}" \
  --provenance=true \
  --sbom=true \
  --metadata-file "$META" \
  --push \
  .

# Sign the immutable digest (never a mutable tag), so a re-tag can't shadow the
# signed image. cosign v2 is keyless by default: the signature identity is the
# CI's OIDC token, transparency-logged in Rekor.
DIGEST="$(jq -r '."containerimage.digest"' "$META")"
IMAGE_REF="${ECR_REPOSITORY}@${DIGEST}"
echo "pushed ${ECR_REPOSITORY}:${IMAGE_TAG} (${DIGEST})"

if [[ "${SKIP_SIGN:-0}" == "1" ]]; then
  echo "SKIP_SIGN=1 — not signing"
  exit 0
fi
cosign sign --yes "$IMAGE_REF"
echo "signed ${IMAGE_REF}"
