# Cutover Runbook — ML Go + RiskSeal Live

Last reviewed: 2026-04-21 · Owner: Isaac / on-call engineer · Tickets: VID3-663 (ML go), VID3-713 (RiskSeal live)

This runbook flips two production toggles at the same time:

1. **ML go** — turn on the champion/challenger pipeline in `manual_review_all` mode so the score is logged on every application but humans own every non-rejection decision.
2. **RiskSeal live** — stop returning mock digital-footprint scores and start calling the real RiskSeal API.

Both are low-risk by design: `manual_review_all` cannot autonomously approve, and RiskSeal failures are caught and downgraded to `skipped` inside stage 0.

---

## TL;DR

```bash
# ml-service prod
railway link --project vida-production --service ml-service
railway variables --set ML_MODE=manual_review_all
railway redeploy

# underwriting-service prod
railway link --project vida-production --service underwriting-service
railway variables --set RISKSEAL_MOCK=false
railway redeploy

# verify (runs from your laptop against prod)
INTERNAL_SECRET=<prod value> \
UNDERWRITE_URL=https://underwriting-service-production.up.railway.app/underwrite \
bash scripts/verify-riskseal-live.sh
```

If verification fails → roll back (§6).

---

## 1. Pre-checks (5 min)

Run these before touching any toggle.

```bash
# 1. All prod services healthy
for s in softcredito-adapter payment-server pdf-generator notification-service underwriting-service ml-service; do
  curl -sS -o /dev/null -w "$s: %{http_code}\n" --max-time 5 \
    "https://${s}-production*.up.railway.app/health"
done
# Expected: every line ends with "200"

# 2. Confirm RISKSEAL_API_KEY is set in GitHub Actions secrets
gh secret list --repo IsaacRomayVida/vidafinance | grep RISKSEAL_API_KEY
# Expected: one line showing RISKSEAL_API_KEY with a recent Updated date

# 3. Confirm the same key is wired through to Railway
railway link --project vida-production --service underwriting-service
railway variables | grep -E 'RISKSEAL_(MOCK|API_KEY|BASE_URL)'
# Expected:
#   RISKSEAL_MOCK=true           ← we're about to flip this
#   RISKSEAL_API_KEY=<real key>  ← must not say PENDING_CONTRACT
#   RISKSEAL_BASE_URL=https://api.riskseal.io/v1
```

If `RISKSEAL_API_KEY` still reads `PENDING_CONTRACT` on Railway, **stop**. Set it first:

```bash
railway variables --set RISKSEAL_API_KEY=<value from password manager>
```

---

## 2. Announce (1 min)

Post in `#vida-launch` before flipping:

```
Starting ML go + RiskSeal live cutover (VID3-663, VID3-713).
Expect: no user-visible impact; all approvals still route to humans.
ETA: 15 min incl. verification. Rollback plan ready.
```

---

## 3. Flip ML (2 min)

```bash
railway link --project vida-production --service ml-service
railway variables --set ML_MODE=manual_review_all
railway redeploy
```

Wait for Railway to report the new deployment as "SUCCESS". Then:

```bash
curl -sS https://ml-service-production-f949.up.railway.app/health
# Expected: {"status":"ok",...}

# Check the mode took effect (the service prints it on startup)
railway logs --service ml-service | grep -i ML_MODE | tail -3
# Expected: at least one line mentioning manual_review_all
```

---

## 4. Flip RiskSeal (2 min)

```bash
railway link --project vida-production --service underwriting-service
railway variables --set RISKSEAL_MOCK=false
railway redeploy
```

Wait for "SUCCESS", then:

```bash
curl -sS https://underwriting-service-production.up.railway.app/health
# Expected: {"status":"ok",...}
```

---

## 5. Verify live (5 min)

Closes **VID3-713**.

```bash
INTERNAL_SECRET=<prod INTERNAL_SECRET from Railway / password manager> \
UNDERWRITE_URL=https://underwriting-service-production.up.railway.app/underwrite \
bash scripts/verify-riskseal-live.sh
```

The script submits a synthetic (but structurally valid) loan application, inspects `stages.stage0.data.riskseal`, and passes only if:

- `mocked` is NOT `true`
- A numeric `score` is present
- `signals` contains real digital-footprint fields (e.g. `email_age_days`, `digital_presence`)

A "PASS" line from the script closes VID3-713. Post the script's output in `#vida-launch`.

Optional spot-check: tail the underwriting-service logs and look for an outbound RiskSeal call:

```bash
railway logs --service underwriting-service | grep -i riskseal | tail -5
```

---

## 6. Rollback (if anything goes wrong)

Either toggle can be reverted independently — they are not coupled.

**ML rollback** (undo §3):

```bash
railway link --project vida-production --service ml-service
railway variables --set ML_MODE=shadow      # or: --unset ML_MODE (defaults to 'auto')
railway redeploy
```

`shadow` behaves identically to `manual_review_all` for decision routing but is a clearer "we've reverted" signal in metrics. Do **not** roll back to `auto` during cutover — that would enable autonomous approvals, which is the opposite of safe.

**RiskSeal rollback** (undo §4):

```bash
railway link --project vida-production --service underwriting-service
railway variables --set RISKSEAL_MOCK=true
railway redeploy
```

The underwriting pipeline tolerates RiskSeal failures (`stage0-fraud.js` catches and sets `skipped: true`), so a partial outage does not require rollback — only roll back if scores look systemically wrong.

---

## 7. Post-cutover watch (2 hours)

Monitor these for 2 hours, then hand off to normal on-call:

- **Dashboard**: `https://vida-finance.web.app/admin/dashboard` — watch approval rate; it should be 0% autonomous (all `manual_review`), up from whatever it was before.
- **Grafana / metrics**:
  - `ml_mode_overrides_total{mode="manual_review_all"}` — should increment on every non-rejected decision
  - 5xx rate on underwriting-service — no change expected
- **Firestore**: `incident_log` collection — look for `source: riskseal-client` entries (would indicate real API errors)
- **RiskSeal dashboard** (if you have access): look at request volume — should show a small number of calls matching today's loan applications

If approval rate ≠ 0% manual or if you see RiskSeal 5xx >5% of calls → roll back the affected toggle.

---

## 8. When ML can move beyond `manual_review_all`

Per `docs/ML_MODEL_STATUS.md` (VID3-661):

- **Don't** flip `ML_MODE=auto` until ~500 resolved loans (repaid or defaulted) exist in Firestore and the champion + challenger have been retrained and backtested on that real data.
- Retraining procedure: `docs/runbooks/model-retrain.md`.
- Validation artefact required before flip: a model card plus a backtest report showing the approval threshold produces an acceptable default rate.

This is a separate cutover, not this runbook.
