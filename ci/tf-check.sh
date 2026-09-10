#!/usr/bin/env bash
# Terraform gate — format + validate every root module. No cloud creds needed
# (validate runs with -backend=false). Called by both CIs.
set -euo pipefail

cd "$(dirname "$0")/.."

# Each Terraform root module: the ECS deployment and the EKS deployment.
for mod in infra/terraform infra/eks; do
  echo "== ${mod} =="
  terraform -chdir="${mod}" fmt -recursive -check -diff
  terraform -chdir="${mod}" init -backend=false -input=false >/dev/null
  terraform -chdir="${mod}" validate
done
