#!/usr/bin/env bash
# Shared verify step (format, lint, types, tests, build), called by both CIs.
set -euo pipefail

pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# The runtime image runs the esbuild bundles, not tsx: prove every entry bundles
# (an unresolvable import or a CJS/ESM mismatch fails here, not at image build time).
pnpm bundle
