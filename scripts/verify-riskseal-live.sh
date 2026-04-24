#!/usr/bin/env bash
# verify-riskseal-live.sh — VID3-713
#
# Proves the live RiskSeal API is actually wired through the underwriting
# pipeline (not the mock). Submits a synthetic loan application to
# underwriting-service /underwrite and asserts that the stage-0 riskseal
# block is *not* marked `mocked: true` and carries a real score/signals.
#
# Usage:
#   INTERNAL_SECRET=<prod or staging INTERNAL_SECRET> \
#   UNDERWRITE_URL=https://underwriting-service-production.up.railway.app/underwrite \
#   bash scripts/verify-riskseal-live.sh
#
# Env:
#   INTERNAL_SECRET   required. x-internal-secret header for /underwrite.
#   UNDERWRITE_URL    required. Full URL including path, e.g.
#                     https://underwriting-service-production.up.railway.app/underwrite
#   TEST_EMAIL        optional. Defaults to a +testing alias.
#   TEST_PHONE        optional. Defaults to a sandbox-safe MX number.
#   TEST_IP           optional. Defaults to an example IP.
#   TEST_RFC          optional. Defaults to a synthetic 13-char RFC.
#
# Exit codes:
#   0 — live RiskSeal confirmed working end-to-end
#   1 — mock still active (RISKSEAL_MOCK=true or mocked:true in response)
#   2 — live mode but RiskSeal call itself failed (pipeline skipped it)
#   3 — request failed (non-2xx from /underwrite)
#   4 — missing required env or deps

set -euo pipefail

# ── dependencies ──────────────────────────────────────────────────────
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' is required but not installed."
    exit 4
  fi
done

# ── required env ──────────────────────────────────────────────────────
if [ -z "${INTERNAL_SECRET:-}" ]; then
  echo "ERROR: INTERNAL_SECRET must be set" >&2
  exit 4
fi
if [ -z "${UNDERWRITE_URL:-}" ]; then
  echo "ERROR: UNDERWRITE_URL must be set (e.g. https://underwriting-service-production.up.railway.app/underwrite)" >&2
  exit 4
fi

TEST_EMAIL="${TEST_EMAIL:-vida-riskseal-verify+$(date +%s)@example.com}"
TEST_PHONE="${TEST_PHONE:-+5215555000001}"
TEST_IP="${TEST_IP:-189.203.10.42}"
TEST_RFC="${TEST_RFC:-VERI900101ABC}"

# ── synthetic applicant + employer ────────────────────────────────────
# Matches the shape consumed by services/underwriting-service/src/stages/stage0-fraud.js
# and the decision engine. Synthetic values — do not correspond to a real person.
read -r -d '' BODY <<JSON || true
{
  "correlationId": "riskseal-verify-$(date +%s)",
  "loanAmount": 5000,
  "applicant": {
    "rfc": "$TEST_RFC",
    "curp": "VERI900101HDFABCD1",
    "email": "$TEST_EMAIL",
    "phone": "$TEST_PHONE",
    "ipAddress": "$TEST_IP",
    "monthlySalary": 15000,
    "employerTier": 2,
    "principalAmount": 5000,
    "requestsLastHour": 0
  },
  "employer": {
    "employerId": "riskseal-verify-employer",
    "companyName": "RiskSeal Verification Co",
    "tier": 2
  }
}
JSON

echo "─── RiskSeal live verification (VID3-713) ────────────────────────"
echo "URL:   $UNDERWRITE_URL"
echo "RFC:   $TEST_RFC   Email: $TEST_EMAIL   IP: $TEST_IP"
echo ""

# ── submit ────────────────────────────────────────────────────────────
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_CODE=$(curl -sS -o "$TMP" -w "%{http_code}" \
  -X POST "$UNDERWRITE_URL" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_SECRET" \
  --max-time 60 \
  --data "$BODY" 2>/dev/null || true)
# On connection failure curl writes "000" to stdout via -w; on success writes the real code.
HTTP_CODE="${HTTP_CODE:-000}"

if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: /underwrite returned HTTP $HTTP_CODE"
  echo "Response body (first 500 chars):"
  head -c 500 "$TMP"; echo
  exit 3
fi

# ── inspect stage0.riskseal ───────────────────────────────────────────
RISKSEAL=$(jq -c '.stages.stage0.data.riskseal // empty' "$TMP")

if [ -z "$RISKSEAL" ]; then
  echo "FAIL: response has no stages.stage0.data.riskseal block."
  echo "Top-level keys in response:"
  jq 'keys' "$TMP"
  exit 3
fi

MOCKED=$(jq -r '.stages.stage0.data.riskseal.mocked // false' "$TMP")
SKIPPED=$(jq -r '.stages.stage0.data.riskseal.skipped // false' "$TMP")
SCORE=$(jq -r '.stages.stage0.data.riskseal.score // "null"' "$TMP")
RISK_LEVEL=$(jq -r '.stages.stage0.data.riskseal.risk_level // "null"' "$TMP")
SIGNAL_COUNT=$(jq -r '.stages.stage0.data.riskseal.signals | if . == null then 0 else (. | keys | length) end' "$TMP")
ERR_MSG=$(jq -r '.stages.stage0.data.riskseal.error // empty' "$TMP")

echo "Parsed riskseal block:"
echo "  mocked:     $MOCKED"
echo "  skipped:    $SKIPPED"
echo "  score:      $SCORE"
echo "  risk_level: $RISK_LEVEL"
echo "  signals:    $SIGNAL_COUNT fields"
[ -n "$ERR_MSG" ] && echo "  error:      $ERR_MSG"
echo ""

# ── verdict ───────────────────────────────────────────────────────────
if [ "$MOCKED" = "true" ]; then
  echo "FAIL: RISKSEAL_MOCK is still true on this environment."
  echo "Fix: railway variables --set RISKSEAL_MOCK=false && railway redeploy"
  exit 1
fi

if [ "$SKIPPED" = "true" ]; then
  echo "FAIL: RiskSeal call was skipped (real API call failed and pipeline fell back)."
  echo "This means live mode is on, but something is wrong — check RISKSEAL_API_KEY / RISKSEAL_BASE_URL,"
  echo "Railway logs for underwriting-service, and the RiskSeal service-status page."
  exit 2
fi

if [ "$SCORE" = "null" ] || [ "$SIGNAL_COUNT" -lt 1 ]; then
  echo "FAIL: RiskSeal returned no score or no signals — the API responded but the payload is empty."
  exit 2
fi

echo "PASS: live RiskSeal verified. VID3-713 closeable."
exit 0
