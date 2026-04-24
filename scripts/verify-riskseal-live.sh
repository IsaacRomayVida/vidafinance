#!/usr/bin/env bash
# verify-riskseal-live.sh — VID3-713
#
# Proves the live RiskSeal API is actually wired to underwriting-service
# (not the mock). Calls GET /riskseal/smoke — a small internal-only endpoint
# that isolates the RiskSeal adapter from the rest of the underwriting
# pipeline — and asserts the response reports `envMock=false` and carries
# a real score/signals payload.
#
# Why the smoke endpoint instead of POST /underwrite?
#   Synthetic applicants short-circuit at employer-screening (stage-a) before
#   stage 0 / RiskSeal ever runs, making end-to-end verification impossible
#   without real employer data. /riskseal/smoke skips that routing and proves
#   the RiskSeal adapter is wired correctly.
#
# Usage:
#   INTERNAL_SECRET=<prod INTERNAL_SECRET> \
#   UNDERWRITE_URL=https://underwriting-service-production.up.railway.app \
#   bash scripts/verify-riskseal-live.sh
#
# Env:
#   INTERNAL_SECRET   required. x-internal-secret header.
#   UNDERWRITE_URL    required. Base URL — no trailing path — e.g.
#                     https://underwriting-service-production.up.railway.app
#                     (will hit $UNDERWRITE_URL/riskseal/smoke).
#                     Accepts the old full-/underwrite URL for compat and
#                     strips it automatically.
#   TEST_EMAIL        optional. Defaults to a +testing alias.
#   TEST_PHONE        optional. Defaults to a sandbox-safe MX number.
#   TEST_IP           optional. Defaults to an example IP.
#   TEST_RFC          optional. Defaults to a synthetic 13-char RFC (mock only).
#
# Exit codes:
#   0 — live RiskSeal confirmed working
#   1 — mock still active (envMock=true or result.mocked=true)
#   2 — live mode but RiskSeal call itself failed (adapter/API/key issue)
#   3 — request failed (non-2xx from /riskseal/smoke)
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
  echo "ERROR: UNDERWRITE_URL must be set (e.g. https://underwriting-service-production.up.railway.app)" >&2
  exit 4
fi

# Accept the legacy full-/underwrite URL for backwards compat.
BASE_URL="${UNDERWRITE_URL%/underwrite}"
BASE_URL="${BASE_URL%/}"
SMOKE_URL="${BASE_URL}/riskseal/smoke"

TEST_EMAIL="${TEST_EMAIL:-vida-riskseal-verify+$(date +%s)@example.com}"
TEST_PHONE="${TEST_PHONE:-+5215555000001}"
TEST_IP="${TEST_IP:-189.203.10.42}"
TEST_RFC="${TEST_RFC:-VERI900101ABC}"

echo "─── RiskSeal live verification (VID3-713) ────────────────────────"
echo "URL:   $SMOKE_URL"
echo "RFC:   $TEST_RFC   Email: $TEST_EMAIL   IP: $TEST_IP"
echo ""

# ── submit ────────────────────────────────────────────────────────────
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# URL-encode the email/phone/ip/rfc query params for safety.
urlenc() { jq -rn --arg v "$1" '$v|@uri'; }
Q_EMAIL=$(urlenc "$TEST_EMAIL")
Q_PHONE=$(urlenc "$TEST_PHONE")
Q_IP=$(urlenc "$TEST_IP")
Q_RFC=$(urlenc "$TEST_RFC")

HTTP_CODE=$(curl -sS -o "$TMP" -w "%{http_code}" \
  "${SMOKE_URL}?email=${Q_EMAIL}&phone=${Q_PHONE}&ip=${Q_IP}&rfc=${Q_RFC}" \
  -H "x-internal-secret: $INTERNAL_SECRET" \
  --max-time 30 2>/dev/null || true)
HTTP_CODE="${HTTP_CODE:-000}"

if [ "$HTTP_CODE" = "502" ]; then
  # Explicit RiskSeal adapter failure — the endpoint responded but the
  # upstream call failed. Dump diagnostics and exit 2.
  echo "FAIL: /riskseal/smoke returned 502 — live mode is on but the RiskSeal call failed."
  ENV_MOCK=$(jq -r '.envMock' "$TMP" 2>/dev/null || echo "?")
  BASE=$(jq -r '.baseUrl // "?"' "$TMP" 2>/dev/null || echo "?")
  HAS_KEY=$(jq -r '.apiKeyPresent // false' "$TMP" 2>/dev/null || echo "?")
  ERR=$(jq -r '.message // "(no message)"' "$TMP" 2>/dev/null || echo "?")
  echo "  envMock:        $ENV_MOCK"
  echo "  baseUrl:        $BASE"
  echo "  apiKeyPresent:  $HAS_KEY"
  echo "  upstream error: $ERR"
  echo ""
  echo "Next: check RISKSEAL_API_KEY / RISKSEAL_BASE_URL in Railway, and the RiskSeal status page."
  exit 2
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: /riskseal/smoke returned HTTP $HTTP_CODE"
  echo "Response body (first 500 chars):"
  head -c 500 "$TMP"; echo
  exit 3
fi

# ── parse ─────────────────────────────────────────────────────────────
ENV_MOCK=$(jq -r '.envMock' "$TMP")
BASE_URL_REPORTED=$(jq -r '.baseUrl // "null"' "$TMP")
API_KEY_PRESENT=$(jq -r '.apiKeyPresent' "$TMP")
DUR=$(jq -r '.durationMs' "$TMP")
RESULT_MOCKED=$(jq -r '.result.mocked // false' "$TMP")
SCORE=$(jq -r '.result.score // "null"' "$TMP")
RISK_LEVEL=$(jq -r '.result.risk_level // "null"' "$TMP")
SIGNAL_COUNT=$(jq -r '.result.signals | if . == null then 0 else (. | keys | length) end' "$TMP")

echo "Smoke response:"
echo "  envMock:        $ENV_MOCK"
echo "  baseUrl:        $BASE_URL_REPORTED"
echo "  apiKeyPresent:  $API_KEY_PRESENT"
echo "  durationMs:     $DUR"
echo "  result.mocked:  $RESULT_MOCKED"
echo "  score:          $SCORE"
echo "  risk_level:     $RISK_LEVEL"
echo "  signals:        $SIGNAL_COUNT fields"
echo ""

# ── verdict ───────────────────────────────────────────────────────────
if [ "$ENV_MOCK" = "true" ] || [ "$RESULT_MOCKED" = "true" ]; then
  echo "FAIL: RISKSEAL_MOCK is still true on this environment."
  echo "Fix: railway variables --service underwriting-service --set RISKSEAL_MOCK=false && railway redeploy"
  exit 1
fi

if [ "$API_KEY_PRESENT" != "true" ]; then
  echo "FAIL: RISKSEAL_API_KEY is not set."
  exit 2
fi

if [ "$SCORE" = "null" ] || [ "$SIGNAL_COUNT" -lt 1 ]; then
  echo "FAIL: RiskSeal responded but returned no score or no signals."
  exit 2
fi

echo "PASS: live RiskSeal verified (envMock=false, apiKey set, score=$SCORE, $SIGNAL_COUNT signals). VID3-713 closeable."
exit 0
