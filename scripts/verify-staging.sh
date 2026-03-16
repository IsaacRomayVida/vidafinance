#!/usr/bin/env bash
# Verify all 5 VIDA staging microservices are healthy on Railway
# Railway project: observant-miracle (vida-staging)
# Run: bash scripts/verify-staging.sh

SERVICES=(
  "vida-payment-server|https://payment-server-production-b9b8.up.railway.app"
  "vida-softcredito|https://softcredito-adapter-production.up.railway.app"
  "vida-notifications|https://notification-service-production-f49e.up.railway.app"
  "vida-pdf-generator|https://pdf-generator-production-1a31.up.railway.app"
  "vida-ml-service|https://ml-service-production-f949.up.railway.app"
)

echo ""
echo "VIDA Finance — Staging Health Check"
echo "===================================="
echo ""

PASS=0
FAIL=0

for entry in "${SERVICES[@]}"; do
  IFS='|' read -r name url <<< "$entry"

  body=$(curl -sf --max-time 15 "$url/health" 2>/dev/null)
  exit_code=$?

  if [ $exit_code -eq 0 ]; then
    redis=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('redis', False))" 2>/dev/null)
    status=$(echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null)
    echo "✅  $name"
    echo "    status=$status | redis=$redis"
    echo "    $body"
    PASS=$((PASS+1))
  else
    echo "❌  $name (HTTP error or timeout)"
    FAIL=$((FAIL+1))
  fi
  echo ""
done

echo "===================================="
if [ "$FAIL" -eq 0 ]; then
  echo "✅  All $PASS services healthy — staging is operational"
else
  echo "❌  $FAIL service(s) failed, $PASS passed"
  exit 1
fi
