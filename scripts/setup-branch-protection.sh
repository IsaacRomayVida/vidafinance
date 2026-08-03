#!/bin/bash
# Run this script as a repository admin to configure branch protection rules.
# Requires: gh CLI authenticated with a token that has admin access to the repo.
#
# Usage: bash scripts/setup-branch-protection.sh

set -e

REPO="IsaacRomayVida/vidafinance"

echo "Setting branch protection on: develop"
gh api "repos/${REPO}/branches/develop/protection" \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Lint, Typecheck & Test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

echo "Setting branch protection on: main"
# Contexts below were reconciled 2026-08-03 against the LIVE required_status_checks
# on main (`gh api repos/${REPO}/branches/main/protection`) — the previous list
# ("Deploy Firebase", "Deploy Railway Services") named jobs that do not exist in
# any current workflow and had silently drifted out of sync with reality.
#
# Added "Deploy Readiness Check ... — #376": that job (.github/workflows/ci.yml,
# job `deploy-readiness`) has run on every PR since #384/#440 and hard-fails on a
# broken Cloud Functions build or export/deploy-list drift, but until now it was
# NOT in required_status_checks — so a PR could merge while it was red. That is
# the same "green PR, undeployable code" blind spot #376 describes, one layer
# down: the check existed but nothing enforced it. It does not touch Firebase
# credentials or `firebase deploy`, so requiring it cannot turn PRs red on the
# pre-existing Firestore-index 403 (that failure lives entirely inside
# deploy.yml's deploy-firebase job, which this script does not touch).
gh api "repos/${REPO}/branches/main/protection" \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Lint, Typecheck & Test",
      "Frontend Lint, Typecheck & Build",
      "Lint, Type-check & Unit Tests",
      "Integration Tests (Decision Engine)",
      "Deploy Readiness Check (build + export drift, no credentials) — #376"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

echo ""
echo "Branch protection rules applied successfully."
echo "  develop: requires PR + 1 review + 'test' CI job passing"
echo "  main:    requires PR + 1 review + CI + deploy-workflow test jobs + the"
echo "           credential-free Deploy Readiness Check (#376), + enforce_admins"
