#!/usr/bin/env bash
# Shared verify step (format, lint, types, tests, build), called by both CIs.
set -euo pipefail

pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
