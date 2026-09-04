#!/usr/bin/env bash
# Verify the VIDA STAGING microservices are healthy — honestly.
#
# What this file used to do, said plainly: it printed "Staging Health Check"
# and then probed the six PRODUCTION URLs. Every green run was a claim about
# the wrong environment. Meanwhile the actual staging path has been dead for
# months: deploy.yml's staging branch (`develop`) is ~480 commits behind
# `main`, and no staging service URLs are recorded anywhere in this repo.
#
# So this script now refuses to lie. It probes ONLY URLs you explicitly hand
# it via STAGING_*_URL environment variables, and exits loudly when none are
# set — because "staging is fine" from a script with no staging URLs is the
# same tick-with-no-evidence the launch checklist v1.8 exists to forbid.
#
# Run: STAGING_PAYMENT_SERVER_URL=https://... [more STAGING_*_URL=...] \
#        bash scripts/verify-staging.sh
#
# Production health lives elsewhere:
#   - scripts/check-production-health.mjs (canonical URLs, credential-free)
#   - .github/workflows/verify-production-live.yml (scheduled, gating)

set -u

VARS=(
  "STAGING_PAYMENT_SERVER_URL"
  "STAGING_SOFTCREDITO_ADAPTER_URL"
  "STAGING_NOTIFICATION_SERVICE_URL"
  "STAGING_PDF_GENERATOR_URL"
  "STAGING_ML_SERVICE_URL"
  "STAGING_UNDERWRITING_SERVICE_URL"
)

echo ""
echo "VIDA Finance — Staging Health Check"
echo "===================================="
echo ""

CONFIGURED=0
PASS=0
FAIL=0

for var in "${VARS[@]}"; do
  url="${!var:-}"
  name="${var#STAGING_}"
  name="${name%_URL}"

  if [ -z "$url" ]; then
    echo "—  ${name}: ${var} not set (skipped — no URL, no claim)"
    continue
  fi
  CONFIGURED=$((CONFIGURED+1))

  body=$(curl -sf --max-time 15 "${url%/}/health" 2>/dev/null)
  if [ $? -eq 0 ]; then
    status=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "non-json")
    redis=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('redis',''))" 2>/dev/null || echo "")
    echo "✅  ${name}: status=${status} redis=${redis}"
    PASS=$((PASS+1))
  else
    echo "❌  ${name}: ${url%/}/health unreachable or non-200"
    FAIL=$((FAIL+1))
  fi
done

echo ""
if [ "$CONFIGURED" -eq 0 ]; then
  echo "NO STAGING URLS CONFIGURED — nothing was verified, and that is the finding:"
  echo "this repo records no staging endpoints, deploy.yml's staging branch (develop)"
  echo "is hundreds of commits behind main, and RAILWAY_TOKEN_STAGING is never"
  echo "exercised. Either stand staging up (and record its URLs here and in"
  echo "scripts/production-endpoints.json's pattern) or remove the staging path"
  echo "from deploy.yml so it stops implying an environment that does not exist."
  exit 1
fi

echo "Result: ${PASS} healthy, ${FAIL} failing, of ${CONFIGURED} configured."
[ "$FAIL" -eq 0 ] || exit 1
