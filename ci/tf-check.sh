#!/usr/bin/env bash
# Terraform gate — format + validate both environments. No cloud creds needed
# (validate runs with -backend=false). Called by both CIs.
set -euo pipefail

cd "$(dirname "$0")/../infra/terraform"

terraform fmt -recursive -check -diff

for env in dev prod; do
  echo "== validate envs/$env =="
  (
    cd "envs/$env"
    terraform init -backend=false -input=false >/dev/null
    terraform validate
  )
done
