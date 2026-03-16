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
gh api "repos/${REPO}/branches/main/protection" \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --input - << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Lint, Typecheck & Test", "Deploy Firebase", "Deploy Railway Services"]
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
echo "  main:    requires PR + 1 review + all CI + deploy jobs passing + enforce_admins"
