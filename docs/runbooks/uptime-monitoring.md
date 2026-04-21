# Uptime Monitoring Runbook — VIDA Finance

Last reviewed: 2026-04-21 · Owner: Isaac / on-call engineer

External uptime monitoring is the last line of defense: if the app goes down and nothing else alerts (Sentry is quiet because JS never loaded, Datadog is quiet because Cloud Functions never fired), this is what pages us. The Puppeteer E2E smoke (`.github/workflows/e2e-smoke.yml`) runs only nightly, so by itself it can miss a 12-hour outage.

This runbook describes the exact monitors to stand up, the alerting contacts, and how to verify the setup once deployed.

---

## TL;DR

Provision **6 HTTPS health monitors** in UptimeRobot (or Pingdom, Better Uptime, etc.) pointing at the canonical production URLs below, all on a **1-minute interval**, alerting to **PagerDuty/Slack** after two consecutive failures. Cost: free tier on UptimeRobot covers 50 monitors at 5-min intervals; the 1-min interval needs the Pro plan (~$7/mo) or Better Uptime's free tier.

Total budget: **$7–10/mo**. Setup time: **~20 minutes**.

---

## 1. What to monitor

| # | Service | URL | Expected response | Why it matters |
|---|---|---|---|---|
| 1 | Firebase Hosting (public site) | `https://vida-finance.web.app/` | HTTP 200, HTML contains `<div id="root">` | If this is down, marketing funnel + app are both dead |
| 2 | Payment server | `https://vida-payment-server.railway.app/health` | HTTP 200, body contains `"status":"ok"` | Payment link generation + Softcredito webhook relay |
| 3 | Softcredito adapter | `https://vida-softcredito.railway.app/health` | HTTP 200 | Loan disbursement funnel; downtime blocks origination |
| 4 | Notifications | `https://vida-notifications.railway.app/health` | HTTP 200 | SMS + email; failure is silent (no user-facing error) |
| 5 | PDF generator | `https://vida-pdf-generator.railway.app/health` | HTTP 200 | Contract PDFs for legal compliance |
| 6 | ML service | `https://vida-ml-service.railway.app/health` | HTTP 200 | Credit scoring; failure falls back to rules engine |

**Not monitored externally** (these have better native telemetry):
- Cloud Functions — covered by GCP Cloud Monitoring + the Sentry wiring shipped in #354
- Firestore — covered by Firebase SLO dashboards
- Firebase Auth — covered by `/login` smoke test (Puppeteer) + Firebase console

---

## 2. Monitor configuration (UptimeRobot)

For each of the 6 services above:

- **Monitor type**: `HTTPS`
- **URL**: (from table)
- **Monitoring interval**: `1 minute`
- **Monitor timeout**: `30 seconds` (Railway cold-start tolerance)
- **Alert contacts**:
    - Primary: on-call phone via **PagerDuty integration** (see §4)
    - Secondary: **Slack `#vida-ops`** channel
    - Tertiary: Isaac's email (for visibility)
- **Confirm failure before alerting**: `2 attempts`  (avoids single-packet-loss flakes)
- **Custom HTTP status codes**: accept only `200`. Reject `3xx`/`4xx`/`5xx`.
- **Keyword monitoring** (where applicable):
    - For the public site, require the string `id="root"` in the response body. Without this, an empty 200 "hosting is up but our app isn't" still alerts.
    - For each Railway service, require `"status":"ok"` in the JSON body.

---

## 3. Per-service runbook links

When a monitor pages, the first thing to check is service-specific. Each alert message should include a `Runbook:` field pointing at the matching section:

| Monitor | Runbook entry |
|---|---|
| Hosting | `docs/runbooks/deploy.md` §7 (rollback paths) |
| Payment server | `docs/runbooks/provider-failover.md` §Stripe/Softcredito failover |
| Softcredito adapter | `docs/runbooks/provider-failover.md` §Softcredito failover |
| Notifications | `docs/runbooks/alerting-runbook.md` §Twilio / SendGrid |
| PDF generator | `docs/runbooks/incident-response.md` §Non-critical service |
| ML service | `docs/runbooks/model-retrain.md` §Fallback to rules-engine |

---

## 4. Alerting channels

### PagerDuty (primary, on-call only)

- Service: "VIDA Production Uptime"
- Escalation policy: **5 min → primary on-call (Isaac) → 15 min → secondary**
- UptimeRobot has a native PagerDuty integration — use the "Create Integration" flow in PagerDuty and paste the integration URL into UptimeRobot's alert contacts.
- Only pages for the **3 critical** services (Hosting, Payment server, Softcredito adapter). The other 3 alert Slack-only because their failure is recoverable without user impact.

### Slack

- Channel: `#vida-ops`
- All 6 monitors post here on both down and recovery events
- Format: `🚨 [DOWN] service | status 500 | runbook: …`

### Email

- `isaac@vidafinance.mx` + `alerts@vidafinance.mx` (both for redundancy)
- Summary-only, not a primary channel

---

## 5. Creating the monitors (script)

UptimeRobot has a public API. Rather than click through the UI six times, run:

```bash
export UPTIMEROBOT_API_KEY="u<your-main-api-key>"
export PD_INTEGRATION_URL="https://events.pagerduty.com/integration/<key>/enqueue"
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

# Add the contacts once (IDs returned here are used below)
curl -X POST "https://api.uptimerobot.com/v2/newAlertContact" \
  -d "api_key=$UPTIMEROBOT_API_KEY&friendly_name=PagerDuty&type=11&value=$PD_INTEGRATION_URL&format=json"

curl -X POST "https://api.uptimerobot.com/v2/newAlertContact" \
  -d "api_key=$UPTIMEROBOT_API_KEY&friendly_name=Slack&type=11&value=$SLACK_WEBHOOK_URL&format=json"

# Then create one monitor per service. Replace CONTACTS_CSV with the IDs
# returned from the two calls above, formatted as "2519123_0_0-2519124_0_0".
for svc in \
  "VIDA Hosting|https://vida-finance.web.app/" \
  "VIDA Payment Server|https://vida-payment-server.railway.app/health" \
  "VIDA Softcredito|https://vida-softcredito.railway.app/health" \
  "VIDA Notifications|https://vida-notifications.railway.app/health" \
  "VIDA PDF Generator|https://vida-pdf-generator.railway.app/health" \
  "VIDA ML Service|https://vida-ml-service.railway.app/health"; do
  name="${svc%%|*}"; url="${svc##*|}"
  curl -X POST "https://api.uptimerobot.com/v2/newMonitor" \
    -d "api_key=$UPTIMEROBOT_API_KEY" \
    -d "friendly_name=$name" \
    -d "url=$url" \
    -d "type=1" \
    -d "interval=60" \
    -d "timeout=30" \
    -d "alert_contacts=$CONTACTS_CSV" \
    -d "format=json"
done
```

Save the resulting monitor IDs to `docs/runbooks/uptime-monitoring.md` §7 (IDs table) so future engineers can modify or delete them cleanly.

---

## 6. Verification checklist

After running the script above:

- [ ] All 6 monitors show **"Up"** in the UptimeRobot dashboard after ~2 minutes
- [ ] Temporarily rename one Railway service to break its URL, wait 2 minutes, confirm Slack + PagerDuty alerts both fire, then restore and confirm recovery alerts
- [ ] Open the UptimeRobot public status page (if enabled) at `https://status.vidafinance.mx` and confirm it renders
- [ ] Confirm monthly billing plan shows "Pro ($7/mo)" if using 1-min intervals — free tier caps at 5 min

---

## 7. Monitor IDs (fill in after provisioning)

| Monitor | ID | Status page slug |
|---|---|---|
| VIDA Hosting | _TBD_ | _TBD_ |
| VIDA Payment Server | _TBD_ | _TBD_ |
| VIDA Softcredito | _TBD_ | _TBD_ |
| VIDA Notifications | _TBD_ | _TBD_ |
| VIDA PDF Generator | _TBD_ | _TBD_ |
| VIDA ML Service | _TBD_ | _TBD_ |

PagerDuty integration key: _TBD_
Slack webhook: _TBD_ (check 1Password under `VIDA · UptimeRobot`)

---

## 8. Interaction with existing tooling

| Tool | Role | Overlap with UptimeRobot |
|---|---|---|
| `scripts/verify-production.js` | Ad-hoc / CI diagnostic — "are all endpoints reachable from wherever I'm running this right now" | Complementary. Runs on-demand only. |
| `.github/workflows/e2e-smoke.yml` | Nightly Puppeteer smoke, asserts the app *renders*, not just that the HTTP endpoint is up | Complementary. 24h detection latency. |
| Sentry (frontend + functions, added in #354) | Error telemetry, not reachability | Complementary. Sentry goes silent during a total outage. |
| Railway built-in metrics | Per-service CPU/memory/traffic graphs | Complementary. Doesn't page. |

UptimeRobot is the only tool that meets all three of: **1-minute detection latency**, **external vantage point** (not in our VPC), and **phone-ringing escalation**.

---

## 9. Out-of-scope (intentionally)

- **Synthetic transaction monitoring** (e.g. "log in → request loan → confirm state"). Far too much setup for a pre-launch team; punt to Datadog Synthetics once we have paying customers.
- **Geographic multi-region checks**. UptimeRobot Pro gives us North America by default, which matches our user base (Mexico).
- **SSL certificate expiry alerts**. Firebase Hosting and Railway auto-renew; if we ever move off, revisit.

---

## 10. Historical context

Before this runbook, uptime detection relied on:

- The old `scripts/verify-production.js` job in CI — which only ran on push-to-main, not continuously, and was made non-gating in #353 after repeated false failures
- Users reporting "the app is down" via support email — a **~2-hour** detection latency in the worst case

Adding external monitoring is the last critical observability gap before launch. Sentry (#354) covers errors, this covers reachability. Together they give us the "something is wrong" signal; the runbooks in this folder give us the "now what" answer.

---

## Related runbooks

- `deploy.md` — how deploys flow, rollback procedures
- `incident-response.md` — overall incident playbook and escalation
- `provider-failover.md` — Stripe / Softcredito / Twilio failover
- `alerting-runbook.md` — how to triage every alert type
