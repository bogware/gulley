#!/usr/bin/env bash
# Apply the repo-level security settings that GitHub only permits on a PUBLIC repo
# (branch protection, secret scanning + push protection). Run this ONCE, right after
# making the repository public. Needs the `gh` CLI, authenticated with admin rights.
#
#   bash ci/harden-public-repo.sh            # uses this repo's origin
#   REPO=owner/name bash ci/harden-public-repo.sh
#
# The default GITHUB_TOKEN permission and the split-runner posture are already set in
# the workflows; see docs/CI_SECURITY.md for the full posture and the fork-PR-approval
# UI toggle (Settings -> Actions -> General -> require approval for outside collaborators).
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
echo "Hardening ${REPO} ..."

echo "-> default GITHUB_TOKEN = read-only"
gh api -X PUT "repos/${REPO}/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null

echo "-> secret scanning + push protection"
gh api -X PATCH "repos/${REPO}" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' >/dev/null

echo "-> branch protection on main (PR review + required checks; no force-push/delete; admins may bypass)"
gh api -X PUT "repos/${REPO}/branches/main/protection" --input - >/dev/null <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "hotpath", "terraform", "deploy-manifests"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "-> code scanning (CodeQL) runs from .github/workflows/codeql.yml; results appear under Security -> Code scanning."

# GHCR package visibility: the container package at ghcr.io/${REPO} is created by
# the first release run and defaults to PRIVATE. Flip it to public so self-hosters
# can pull. It cannot be set before the package exists, so this is a best-effort
# nudge, not a hard step.
PKG="${REPO##*/}"
echo "-> GHCR package visibility (best effort; only works once the first release has pushed the image)"
if gh api -X PATCH "user/packages/container/${PKG}" -f visibility=public >/dev/null 2>&1; then
  echo "   set ghcr.io/${REPO} package to public"
else
  echo "   NOTE: could not set it automatically. After the first release, make it public in"
  echo "   the package settings: https://github.com/users/${REPO%%/*}/packages/container/${PKG}/settings"
fi

echo "Done. Verify in Settings -> Branches, Settings -> Code security, and the package's visibility."
