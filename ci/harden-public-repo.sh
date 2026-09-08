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
  "required_status_checks": { "strict": true, "contexts": ["verify", "hotpath", "terraform"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "Done. Verify in Settings -> Branches and Settings -> Code security."
