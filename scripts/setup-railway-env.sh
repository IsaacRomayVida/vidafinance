#!/usr/bin/env bash
# Railway environment variable setup script for VIDA Finance staging
# Usage: RAILWAY_TOKEN=<token> bash scripts/setup-railway-env.sh
#
# Requires: @railway/cli installed globally (npm install -g @railway/cli)
# All env var values with <...> placeholders must be provided as environment variables
# before running this script, or you will be prompted for them.

set -euo pipefail

# ── Auth ──────────────────────────────────────────────────────────────────────
if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "❌ RAILWAY_TOKEN is not set. Export it before running this script."
  exit 1
fi
export RAILWAY_TOKEN

# ── Helper: prompt for value if not set ──────────────────────────────────────
require_var() {
  local var_name="$1"
  local description="$2"
  if [ -z "${!var_name:-}" ]; then
    read -rp "Enter $description ($var_name): " value
    export "$var_name=$value"
  fi
}

echo "🚀 Setting Railway environment variables for vida-staging project..."
echo ""

# ── Verify Railway CLI is installed ──────────────────────────────────────────
if ! command -v railway &>/dev/null; then
  echo "Installing Railway CLI..."
  npm install -g @railway/cli
fi

# ── Check Railway project ─────────────────────────────────────────────────────
echo "📋 Available projects:"
railway list 2>/dev/null || true
echo ""

# ── Prompt for required secrets if not provided ──────────────────────────────
require_var "FIREBASE_SERVICE_ACCOUNT_B64"     "Firebase service account JSON (base64-encoded)"
require_var "INTERNAL_SECRET"                  "Internal service-to-service secret (random string)"
# Default to Railway private networking URL (update if your Redis service has a different name)
REDIS_URL="${REDIS_URL:-redis://vida-redis.railway.internal:6379}"
export REDIS_URL

# Service-specific secrets
require_var "CONEKTA_WEBHOOK_SECRET"           "Conekta webhook secret or public key"
require_var "SOFTCREDITO_CLIENT_ID"            "SoftCrédito client ID"
require_var "SOFTCREDITO_CLIENT_SECRET"        "SoftCrédito client secret"
require_var "TWILIO_ACCOUNT_SID"               "Twilio account SID"
require_var "TWILIO_AUTH_TOKEN"                "Twilio auth token"
require_var "SENDGRID_API_KEY"                 "SendGrid API key"
require_var "ANTHROPIC_API_KEY"               "Anthropic API key"
require_var "MIFIEL_APP_ID"                   "Mifiel app ID"
require_var "MIFIEL_APP_SECRET"               "Mifiel app secret"

# Optional — defaults provided
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-vida-finance-staging}"
FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-vida-finance-staging.appspot.com}"

# ── service: vida-payment-server ─────────────────────────────────────────────
echo "⚙️  Configuring vida-payment-server (port 3001)..."
railway variables set \
  NODE_ENV=staging \
  PORT=3001 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  CONEKTA_WEBHOOK_SECRET="$CONEKTA_WEBHOOK_SECRET" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  ALLOWED_ORIGINS="https://vida-staging.web.app,https://admin-staging.vida.com" \
  SOFTCREDITO_ADAPTER_URL="http://vida-softcredito.railway.internal:3002" \
  NOTIFICATION_SERVICE_URL="http://vida-notifications.railway.internal:3003" \
  ML_SERVICE_URL="http://vida-ml-service.railway.internal:3005" \
  --service vida-payment-server 2>/dev/null || \
railway variables set \
  NODE_ENV=staging \
  PORT=3001 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  CONEKTA_WEBHOOK_SECRET="$CONEKTA_WEBHOOK_SECRET" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  ALLOWED_ORIGINS="https://vida-staging.web.app,https://admin-staging.vida.com" \
  SOFTCREDITO_ADAPTER_URL="http://vida-softcredito.railway.internal:3002" \
  NOTIFICATION_SERVICE_URL="http://vida-notifications.railway.internal:3003" \
  ML_SERVICE_URL="http://vida-ml-service.railway.internal:3005" \
  --service payment-server
echo "✅ vida-payment-server configured"

# ── service: vida-softcredito ─────────────────────────────────────────────────
echo "⚙️  Configuring vida-softcredito (port 3002)..."
railway variables set \
  NODE_ENV=staging \
  PORT=3002 \
  REDIS_URL="$REDIS_URL" \
  REDIS_CACHE_TTL=86400 \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  SOFTCREDITO_API_URL="https://api.softcredito.com.mx/v1" \
  SOFTCREDITO_CLIENT_ID="$SOFTCREDITO_CLIENT_ID" \
  SOFTCREDITO_CLIENT_SECRET="$SOFTCREDITO_CLIENT_SECRET" \
  PAYMENT_SERVER_URL="http://vida-payment-server.railway.internal:3001" \
  --service vida-softcredito 2>/dev/null || \
railway variables set \
  NODE_ENV=staging \
  PORT=3002 \
  REDIS_URL="$REDIS_URL" \
  REDIS_CACHE_TTL=86400 \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  SOFTCREDITO_API_URL="https://api.softcredito.com.mx/v1" \
  SOFTCREDITO_CLIENT_ID="$SOFTCREDITO_CLIENT_ID" \
  SOFTCREDITO_CLIENT_SECRET="$SOFTCREDITO_CLIENT_SECRET" \
  PAYMENT_SERVER_URL="http://vida-payment-server.railway.internal:3001" \
  --service softcredito-adapter
echo "✅ vida-softcredito configured"

# ── service: vida-notifications ───────────────────────────────────────────────
echo "⚙️  Configuring vida-notifications (port 3003)..."
railway variables set \
  NODE_ENV=staging \
  PORT=3003 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
  TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
  TWILIO_WHATSAPP_FROM="+14155238886" \
  TWILIO_SMS_FROM="+15551234567" \
  SENDGRID_API_KEY="$SENDGRID_API_KEY" \
  SENDGRID_FROM_EMAIL="noreply@vida.finance" \
  SENDGRID_FROM_NAME="VIDA Finance" \
  --service vida-notifications 2>/dev/null || \
railway variables set \
  NODE_ENV=staging \
  PORT=3003 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  TWILIO_ACCOUNT_SID="$TWILIO_ACCOUNT_SID" \
  TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
  TWILIO_WHATSAPP_FROM="+14155238886" \
  TWILIO_SMS_FROM="+15551234567" \
  SENDGRID_API_KEY="$SENDGRID_API_KEY" \
  SENDGRID_FROM_EMAIL="noreply@vida.finance" \
  SENDGRID_FROM_NAME="VIDA Finance" \
  --service notification-service
echo "✅ vida-notifications configured"

# ── service: vida-pdf-generator ───────────────────────────────────────────────
echo "⚙️  Configuring vida-pdf-generator (port 3004)..."
railway variables set \
  NODE_ENV=staging \
  PORT=3004 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  FIREBASE_STORAGE_BUCKET="$FIREBASE_STORAGE_BUCKET" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  PDF_STORAGE_PATH="documents/" \
  MAX_CONCURRENT_PDF_JOBS=3 \
  SOFOM_RFC="VIDA240101XXX" \
  SOFOM_ADDRESS="Paseo de la Reforma 250 Piso 12, CDMX" \
  MIFIEL_APP_ID="$MIFIEL_APP_ID" \
  MIFIEL_APP_SECRET="$MIFIEL_APP_SECRET" \
  MIFIEL_ENV="sandbox" \
  --service vida-pdf-generator 2>/dev/null || \
railway variables set \
  NODE_ENV=staging \
  PORT=3004 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  FIREBASE_STORAGE_BUCKET="$FIREBASE_STORAGE_BUCKET" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  PDF_STORAGE_PATH="documents/" \
  MAX_CONCURRENT_PDF_JOBS=3 \
  SOFOM_RFC="VIDA240101XXX" \
  SOFOM_ADDRESS="Paseo de la Reforma 250 Piso 12, CDMX" \
  MIFIEL_APP_ID="$MIFIEL_APP_ID" \
  MIFIEL_APP_SECRET="$MIFIEL_APP_SECRET" \
  MIFIEL_ENV="sandbox" \
  --service pdf-generator
echo "✅ vida-pdf-generator configured"

# ── service: vida-ml-service ──────────────────────────────────────────────────
echo "⚙️  Configuring vida-ml-service (port 3005)..."
railway variables set \
  PORT=3005 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  MODEL_PATH="models/underwriting_v1.joblib" \
  USE_ML_MODELS="false" \
  ML_CACHE_TTL=86400 \
  --service vida-ml-service 2>/dev/null || \
railway variables set \
  PORT=3005 \
  REDIS_URL="$REDIS_URL" \
  FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
  FIREBASE_SERVICE_ACCOUNT_B64="$FIREBASE_SERVICE_ACCOUNT_B64" \
  INTERNAL_SECRET="$INTERNAL_SECRET" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  MODEL_PATH="models/underwriting_v1.joblib" \
  USE_ML_MODELS="false" \
  ML_CACHE_TTL=86400 \
  --service ml-service
echo "✅ vida-ml-service configured"

echo ""
echo "🎉 All Railway environment variables configured!"
echo ""
echo "Next steps:"
echo "  1. Trigger a deployment: push to main/develop or use 'railway up' per service"
echo "  2. Verify health endpoints:"
echo "     curl https://vida-payment-server.railway.app/health"
echo "     curl https://vida-softcredito.railway.app/health"
echo "     curl https://vida-notifications.railway.app/health"
echo "     curl https://vida-pdf-generator.railway.app/health"
echo "     curl https://vida-ml-service.railway.app/health"
