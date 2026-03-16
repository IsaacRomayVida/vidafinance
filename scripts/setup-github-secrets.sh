#!/usr/bin/env bash
# GitHub repository secrets setup for VIDA Finance CI/CD
# Usage: GITHUB_TOKEN=<pat> RAILWAY_TOKEN=<token> [...other secrets...] bash scripts/setup-github-secrets.sh
#
# Required env vars:
#   GITHUB_TOKEN or GH_TOKEN    — GitHub PAT with repo + secrets scopes
#   RAILWAY_TOKEN               — Railway project deploy token
#   FIREBASE_SERVICE_ACCOUNT_STAGING — base64-encoded Firebase service account JSON
#
# Optional (will prompt if missing):
#   CONEKTA_WEBHOOK_SECRET, SOFTCREDITO_CLIENT_ID, SOFTCREDITO_CLIENT_SECRET,
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY,
#   ANTHROPIC_API_KEY, MIFIEL_APP_ID, MIFIEL_APP_SECRET, INTERNAL_SECRET

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-IsaacRomayVida/vidafinance}"

# ── Auth ──────────────────────────────────────────────────────────────────────
if [ -n "${GITHUB_PAT:-}" ]; then
  export GH_TOKEN="$GITHUB_PAT"
elif [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "❌ Neither GITHUB_PAT nor GH_TOKEN is set. Export one before running."
  exit 1
fi

if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "❌ RAILWAY_TOKEN is not set."
  exit 1
fi

# ── Helper ────────────────────────────────────────────────────────────────────
require_var() {
  local var_name="$1"
  local description="$2"
  if [ -z "${!var_name:-}" ]; then
    read -rsp "Enter $description ($var_name): " value
    echo ""
    export "$var_name=$value"
  fi
}

set_secret() {
  local name="$1"
  local value="$2"
  echo -n "  Setting $name... "
  echo "$value" | gh secret set "$name" --repo "$REPO"
  echo "✅"
}

echo "🔐 Setting GitHub Actions secrets for $REPO..."
echo ""

# ── Prompt for missing secrets ────────────────────────────────────────────────
require_var "FIREBASE_SERVICE_ACCOUNT_STAGING" "Firebase service account (base64-encoded JSON)"
require_var "INTERNAL_SECRET"                  "Internal service-to-service shared secret"
require_var "CONEKTA_WEBHOOK_SECRET"           "Conekta webhook secret"
require_var "SOFTCREDITO_CLIENT_ID"            "SoftCrédito client ID"
require_var "SOFTCREDITO_CLIENT_SECRET"        "SoftCrédito client secret"
require_var "TWILIO_ACCOUNT_SID"               "Twilio account SID"
require_var "TWILIO_AUTH_TOKEN"                "Twilio auth token"
require_var "SENDGRID_API_KEY"                 "SendGrid API key"
require_var "ANTHROPIC_API_KEY"               "Anthropic API key"
require_var "MIFIEL_APP_ID"                   "Mifiel app ID"
require_var "MIFIEL_APP_SECRET"               "Mifiel app secret"

FIREBASE_PROJECT_ID_STAGING="${FIREBASE_PROJECT_ID_STAGING:-vida-finance-staging}"
FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-vida-finance-staging.appspot.com}"

echo "Setting secrets..."
set_secret "RAILWAY_TOKEN"                      "$RAILWAY_TOKEN"
set_secret "FIREBASE_PROJECT_ID_STAGING"        "$FIREBASE_PROJECT_ID_STAGING"
set_secret "FIREBASE_SERVICE_ACCOUNT_STAGING"   "$FIREBASE_SERVICE_ACCOUNT_STAGING"
set_secret "FIREBASE_STORAGE_BUCKET"            "$FIREBASE_STORAGE_BUCKET"
set_secret "INTERNAL_SECRET"                    "$INTERNAL_SECRET"
set_secret "CONEKTA_WEBHOOK_SECRET"             "$CONEKTA_WEBHOOK_SECRET"
set_secret "SOFTCREDITO_CLIENT_ID"              "$SOFTCREDITO_CLIENT_ID"
set_secret "SOFTCREDITO_CLIENT_SECRET"          "$SOFTCREDITO_CLIENT_SECRET"
set_secret "TWILIO_ACCOUNT_SID"                 "$TWILIO_ACCOUNT_SID"
set_secret "TWILIO_AUTH_TOKEN"                  "$TWILIO_AUTH_TOKEN"
set_secret "SENDGRID_API_KEY"                   "$SENDGRID_API_KEY"
set_secret "SENDGRID_FROM_EMAIL"                "noreply@vida.finance"
set_secret "ANTHROPIC_API_KEY"                  "$ANTHROPIC_API_KEY"
set_secret "MIFIEL_APP_ID"                      "$MIFIEL_APP_ID"
set_secret "MIFIEL_APP_SECRET"                  "$MIFIEL_APP_SECRET"

echo ""
echo "🎉 All GitHub secrets configured!"
echo ""
echo "Next: push a change to main or use workflow_dispatch to trigger Railway deployment."
echo "  gh workflow run railway-deploy.yml --repo $REPO"
