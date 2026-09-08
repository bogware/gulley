#!/usr/bin/env bash
# Terraform gate — format + validate the single root module. No cloud creds needed
# (validate runs with -backend=false). Called by both CIs.
set -euo pipefail

cd "$(dirname "$0")/../infra/terraform"

terraform fmt -recursive -check -diff

terraform init -backend=false -input=false >/dev/null
terraform validate
