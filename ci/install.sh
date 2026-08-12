#!/usr/bin/env bash
# Shared install step, called by both GitHub Actions and Azure Pipelines so the
# two CIs can never drift. Keep pipeline YAML thin — logic lives here.
set -euo pipefail

corepack enable
pnpm install --frozen-lockfile
