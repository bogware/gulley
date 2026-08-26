#!/usr/bin/env bash
# Hot-path review guard.
#
# The data-plane hot path in apps/gateway/src/routes/messages.ts (and the
# packages whose semantics it depends on) encodes non-negotiable invariants:
# raw-byte fidelity + a single teardown, budget reserve/commit, pre-first-byte-
# only failover, and metering from raw provider usage (see docs/ARCHITECTURE.md
# and CLAUDE.md). A regression here is a SOC 2 / correctness incident, not a
# style nit, so a change that touches these files warrants the adversarial
# review pass (see docs/HOTPATH_REVIEW.md) rather than an ordinary skim.
#
# This script reports which invariants a diff touches. It is INFORMATIONAL by
# default (exit 0). Set HOTPATH_STRICT=1 to make it fail unless a commit in the
# range carries a `Hotpath-Reviewed: <note>` trailer — an explicit, auditable
# acknowledgement that the review happened.
#
# Usage: bash ci/hotpath-guard.sh [BASE_REF]
#   BASE_REF defaults to $HOTPATH_BASE, else origin/main, else main.
set -euo pipefail

# path-glob '|||' invariant-description. Globs are matched with bash ==.
MANIFEST=(
  "apps/gateway/src/routes/messages.ts|||request pipeline: raw-pipe fidelity, single teardown, failover ordering"
  "apps/gateway/src/context.ts|||context wiring: which ports/sinks the pipeline runs with"
  "apps/gateway/src/reconcile.ts|||live route swap: preserving breaker/scoreboard/budget state by reference"
  "packages/budget/*|||budget reserve/commit (TOCTOU-safe worst-case reservation, refund on teardown)"
  "packages/cost/*|||metering semantics: per-provider usage inclusion + golden fixtures"
  "packages/cache/*|||cache key partitioning by authz scope + PII/secret exclusion"
  "packages/routing/*|||failover / circuit breaker / outlier / load balancing"
  "packages/providers/src/sse.ts|||SSE state machine (streaming usage extraction)"
  "packages/providers/src/*eventstream*|||Bedrock vnd.amazon.eventstream decode"
  "packages/guardrails/src/*stream*|||streaming output guardrail primitives (audit-only invariant)"
)

base_ref="${1:-${HOTPATH_BASE:-}}"
if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    base_ref="origin/main"
  else
    base_ref="main"
  fi
fi

# Fall back gracefully if the base isn't available (shallow clone, fork, etc.).
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "hotpath-guard: base ref '$base_ref' not found; skipping (informational)."
  exit 0
fi

merge_base="$(git merge-base "$base_ref" HEAD 2>/dev/null || echo "$base_ref")"
mapfile -t changed < <(git diff --name-only "$merge_base"...HEAD)

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "hotpath-guard: no changes vs $base_ref."
  exit 0
fi

declare -a hits=()
for file in "${changed[@]}"; do
  for entry in "${MANIFEST[@]}"; do
    pattern="${entry%%|||*}"
    desc="${entry##*|||}"
    # shellcheck disable=SC2053
    if [[ "$file" == $pattern ]]; then
      hits+=("$file  →  $desc")
    fi
  done
done

if [[ ${#hits[@]} -eq 0 ]]; then
  echo "hotpath-guard: no hot-path files touched vs $base_ref. ✓"
  exit 0
fi

echo "hotpath-guard: this change touches ${#hits[@]} hot-path invariant(s):"
printf '  • %s\n' "${hits[@]}"
echo
echo "These files encode data-plane invariants. Run the adversarial review pass"
echo "(docs/HOTPATH_REVIEW.md) before merging."

if [[ "${HOTPATH_STRICT:-0}" == "1" ]]; then
  if git log "$merge_base"...HEAD --format='%B' | grep -qiE '^Hotpath-Reviewed:'; then
    echo "hotpath-guard: 'Hotpath-Reviewed:' trailer present — acknowledged. ✓"
    exit 0
  fi
  echo
  echo "HOTPATH_STRICT=1 and no 'Hotpath-Reviewed:' trailer in the commit range."
  echo "Add a trailer to a commit once the review is done, e.g.:"
  echo "  Hotpath-Reviewed: adversarial pass, 0 confirmed findings"
  exit 1
fi

exit 0
