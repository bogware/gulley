#!/usr/bin/env bash
# Build the single monorepo image (runs either app; the ECS task def picks the
# command) for the ECS task platform and push it to ECR with SBOM + provenance
# attestations. Shared by both CIs so image builds can never drift.
#
# Requires (from the CI's OIDC role): ECR_REPOSITORY, IMAGE_TAG, AWS_REGION.
set -euo pipefail

: "${ECR_REPOSITORY:?ECR_REPOSITORY is required (e.g. 123.dkr.ecr.us-east-1.amazonaws.com/gulley-prod)}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${AWS_REGION:?AWS_REGION is required}"

REGISTRY="${ECR_REPOSITORY%%/*}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker buildx build \
  --platform linux/arm64 \
  --file apps/gateway/Dockerfile \
  --tag "${ECR_REPOSITORY}:${IMAGE_TAG}" \
  --provenance=true \
  --sbom=true \
  --push \
  .

echo "pushed ${ECR_REPOSITORY}:${IMAGE_TAG}"
