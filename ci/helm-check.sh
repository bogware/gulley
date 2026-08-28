#!/usr/bin/env bash
# Validate the deploy manifests (Helm chart + docker-compose) without a cluster.
# Mirrors ci/tf-check.sh: a dedicated, no-cloud gate, separate from ci/verify.sh.
# If `helm` is installed it also lints + template-renders the chart.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Structural validation (node)"
node deploy/validate-manifests.mjs

if command -v helm >/dev/null 2>&1; then
  echo "==> helm lint"
  helm lint deploy/helm/gulley
  echo "==> helm template (default values)"
  helm template gulley deploy/helm/gulley >/dev/null
  echo "==> helm template (control-api disabled)"
  helm template gulley deploy/helm/gulley --set controlApi.enabled=false >/dev/null
else
  echo "==> helm not installed; skipped lint/template (structural checks still ran)"
fi

echo "OK"
