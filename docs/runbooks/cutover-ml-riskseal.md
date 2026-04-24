# Cutover Runbook — ML Go + RiskSeal Live

Last reviewed: 2026-04-24 · Owner: Isaac / on-call engineer · Tickets: VID3-663 (ML go), VID3-713 (RiskSeal live)

This runbook covers the two production toggles:

1. **ML go** — turn on the champion/challenger pipeline in `manual_review_all` mode so the score is logged on every application but humans own every non-rejection decision.
2. **RiskSeal live** — stop returning mock digital-footprint scores and start calling the real RiskSeal API.

Both are low-risk by design: `manual_review_all` cannot autonomously approve, and RiskSeal failures are caught and downgraded to `skipped` inside stage 0.

---

## Current state (as of 2026-04-24)

Production is in `observant-miracle` on Railway (not `vida-production` — that project name does not exist; `vida-backend` is leftover/unused).

- **RiskSeal**: already live — `RISKSEAL_MOCK=false`, `RISKSEAL_API_KEY` set, `RISKSEAL_BASE_URL=https://latam-1.riskseal.io` (regional endpoint, not `api.riskseal.io/v1`).
- **ML**: `ML_MODE=manual_review_all` on `observant-miracle/ml-service` (set 2026-04-24 during initial cutover).
- **Caveat — pipeline does not currently reach stage 0 in prod**: employer-screening (stage-a) short-circuits every applicant because SW credentials (`SW_USER`, `SW_PASSWORD`) and `REPSE_URL` are not set. This means real user traffic never calls RiskSeal or ML in the current state. Fixing those provider credentials is tracked separately and is a launch blocker before taking real applications.

---

## TL;DR — fresh cutover (for reference / new env)

```bash
# ml-service prod (replace with your project ID if different)
railway link --project 1ad040b4-6f0b-4530-9f58-0a1ef5e89c75 --environment production --service ml-service
railway variables --service ml-service --set ML_MODE=manual_review_all
railway redeploy --service ml-service

# underwriting-service prod
railway link --project 1ad040b4-6f0b-4530-9f58-0a1ef5e89c75 --environment production --service underwriting-service
railway variables --service underwriting-service --set RISKSEAL_MOCK=false
railway redeploy --service underwriting-service

# verify (runs from your laptop against prod)
INTERNAL_SECRET=<prod value> \
UNDERWRITE_URL=https://underwriting-service-production.up.railway.app \
bash scripts/verify-riskseal-live.sh
```

If verification fails → roll back (§6).

---

## 1. Pre-checks (5 min)

Run these before touching any toggle.

```bash
# 1. underwriting-service + ml-service healthy
curl -sS -o /dev/null -w "underwriting: %{http_code}\n" --max-time 5 \
  https://underwriting-service-production.up.railway.app/health
curl -sS -o /dev/null -w "ml-service: %{http_code}\n" --max-time 5 \
  https://ml-service-production-f949.up.railway.app/health
# Expected: both 200

# 2. Confirm RISKSEAL_API_KEY is set in GitHub Actions secrets
gh secret list --repo IsaacRomayVida/vidafinance | grep RISKSEAL_API_KEY

# 3. Confirm the same key is wired through to Railway
railway link --project observant-miracle --environment production --service underwriting-service
railway variables --service underwriting-service --kv | grep -E '^RISKSEAL_'
# Expected:
#   RISKSEAL_MOCK=false
#   RISKSEAL_API_KEY=<non-empty uuid, not PENDING_CONTRACT>
#   RISKSEAL_BASE_URL=https://latam-1.riskseal.io
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
railway link --project observant-miracle --environment production --service ml-service
railway variables --service ml-service --set ML_MODE=manual_review_all
# A redeploy is triggered automatically on variable change; if not:
railway redeploy --service ml-service
```

Wait for `railway deployment list --service ml-service` to report the new deployment as "SUCCESS". Then:

```bash
curl -sS https://ml-service-production-f949.up.railway.app/health
# Expected: {"status":"ok",...}
```

Confirm the var is set:

```bash
railway variables --service ml-service --kv | grep ML_MODE
# Expected: ML_MODE=manual_review_all
```

---

## 4. Flip RiskSeal (2 min)

```bash
railway link --project observant-miracle --environment production --service underwriting-service
railway variables --service underwriting-service --set RISKSEAL_MOCK=false
railway redeploy --service underwriting-service
```

Wait for "SUCCESS", then:

```bash
curl -sS https://underwriting-service-production.up.railway.app/health
# Expected: {"status":"ok",...}
```

---

## 5. Verify live (5 min)

Closes **VID3-713**. The verification hits the internal-only `GET /riskseal/smoke` endpoint on `underwriting-service`, which isolates the RiskSeal adapter from the rest of the pipeline (stages 0-5 are not involved).

```bash
INTERNAL_SECRET=<prod INTERNAL_SECRET from Railway / password manager> \
UNDERWRITE_URL=https://underwriting-service-production.up.railway.app \
bash scripts/verify-riskseal-live.sh
```

The script passes only if the response reports:

- `envMock: false` (i.e. `RISKSEAL_MOCK` is not `true`)
- `apiKeyPresent: true`
- `result.mocked` is not `true`
- A numeric `score` is present
- `signals` contains at least one field

A "PASS" line closes VID3-713. Post the script's output in `#vida-launch`.

Optional spot-check: tail the underwriting-service logs and look for the outbound RiskSeal call from the smoke endpoint:

```bash
railway logs --service underwriting-service | grep -i riskseal | tail -5
```

---

## 6. Rollback (if anything goes wrong)

Either toggle can be reverted independently — they are not coupled.

**ML rollback** (undo §3):

```bash
railway link --project observant-miracle --environment production --service ml-service
railway variables --service ml-service --set ML_MODE=shadow
railway redeploy --service ml-service
```

`shadow` behaves identically to `manual_review_all` for decision routing but is a clearer "we've reverted" signal in metrics. Do **not** roll back to `auto` during cutover — that would enable autonomous approvals, which is the opposite of safe.

**RiskSeal rollback** (undo §4):

```bash
railway link --project observant-miracle --environment production --service underwriting-service
railway variables --service underwriting-service --set RISKSEAL_MOCK=true
railway redeploy --service underwriting-service
```

The underwriting pipeline tolerates RiskSeal failures (`stage0-fraud.js` catches and sets `skipped: true`), so a partial outage does not require rollback — only roll back if scores look systemically wrong.

---

## 7. Post-cutover watch (2 hours)

Monitor these for 2 hours, then hand off to normal on-call:

- **Dashboard**: `https://vida-finance.web.app/admin/dashboard` — watch approval rate; it should be 0% autonomous (all `manual_review`), up from whatever it was before.
- **Grafana / metrics**:
  - `ml_mode_overrides_total{mode="manual_review_all"}` — should increment on every non-rejected decision (only meaningful once the pipeline reaches stage 3; see Current state caveat)
  - 5xx rate on underwriting-service — no change expected
- **Firestore**: `incident_log` collection — look for `source: riskseal-client` entries (would indicate real API errors)
- **RiskSeal dashboard** (if you have access): look at request volume

If approval rate ≠ 0% manual or if you see RiskSeal 5xx >5% of calls → roll back the affected toggle.

---

## 8. When ML can move beyond `manual_review_all`

Per `docs/ML_MODEL_STATUS.md` (VID3-661):

- **Don't** flip `ML_MODE=auto` until ~500 resolved loans (repaid or defaulted) exist in Firestore and the champion + challenger have been retrained and backtested on that real data.
- Retraining procedure: `docs/runbooks/model-retrain.md`.
- Validation artefact required before flip: a model card plus a backtest report showing the approval threshold produces an acceptable default rate.

This is a separate cutover, not this runbook.
