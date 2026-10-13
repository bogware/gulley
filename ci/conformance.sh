#!/usr/bin/env bash
# Gateway-contract conformance gate: run the contract suite, render the report, and
# fail if the committed docs/CONFORMANCE.md drifted from what the suite proves.
# The report is deterministic (no timestamps), so a diff means a rule's status or
# the rule set changed and the committed report must be regenerated:
#   pnpm --filter @gulley/gateway conformance:report
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

CONFORMANCE_REPORT="$tmp/conformance-report.json" \
CONFORMANCE_MARKDOWN="$tmp/CONFORMANCE.md" \
  pnpm --filter @gulley/gateway exec vitest run contract.conformance

if ! diff -u docs/CONFORMANCE.md "$tmp/CONFORMANCE.md"; then
  echo "conformance: docs/CONFORMANCE.md is stale — run 'pnpm --filter @gulley/gateway conformance:report' and commit it." >&2
  exit 1
fi
echo "conformance: report matches docs/CONFORMANCE.md ✓"
