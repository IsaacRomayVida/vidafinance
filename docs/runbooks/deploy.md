# Deploy Runbook — VIDA Finance

Last reviewed: 2026-04-21 · Owner: Isaac / on-call engineer

This runbook covers how a normal production deploy flows, what to watch during and after, and what to do when something goes wrong. For infrastructure layout and on-call escalation, see `incident-response.md`.

---

## TL;DR

Every push to `main` automatically deploys **Firebase Hosting + Cloud Functions + Firestore rules + Storage rules** to production. No manual step. Railway services (payment-server, softcredito, notifications, pdf-generator, ml-service) deploy separately from their own GitHub pushes, gated on Railway's own build.

A deploy takes ~6–8 minutes. During that window, the app is in a zero-downtime rolling state: Hosting flips atomically at the end, Cloud Functions each flip individually as each finishes rebuilding.

---

## 1. How deploys are triggered

| Trigger | Target | Pipeline |
|---|---|---|
| Merge PR to `main` | Production (`vida-finance`) | `.github/workflows/deploy.yml` |
| Push/merge to `develop` | Staging (`vida-finance-staging`) | same workflow, different branch branch |
| Manual retry | Same | `gh run rerun <run-id>` |
| Manual `firebase deploy` from a dev laptop | **Forbidden on production** | See "Emergency hotfix" below |

There is no "promote staging → prod" mechanism — each environment deploys from its own branch.

---

## 2. What gets deployed

The workflow runs three sequential jobs:

1. **Lint, Type-check & Unit Tests** (~1 min) — runs functions/ Jest suite (213 tests, 96.94% coverage as of 2026-04-21) and ESLint. Blocks deploy on any fail.
2. **Integration Tests (Decision Engine)** (~2 min) — runs JS + Python integration tests with `METAMAP_MOCK=true`, `RISKSEAL_MOCK=true`. Validates the loan-scoring decision paths.
3. **Deploy Firebase** (~4 min) — builds functions, builds `public-v2/` with `VITE_RECAPTCHA_SITE_KEY` baked in, auths to GCP using `FIREBASE_SERVICE_ACCOUNT_PRODUCTION`, runs:

   ```
   firebase deploy \
     --only hosting,functions,firestore:rules,firestore:indexes,storage \
     --project vida-finance \
     --non-interactive
   ```

Changes outside that list (e.g. Firebase Auth config, Storage buckets creation, Extensions) must be applied manually through the Firebase console and should be called out in the PR.

---

## 3. Pre-deploy checklist

Before merging a PR that will deploy to production:

- [ ] CI on the PR is green — all four required checks:
  - `Lint, Typecheck & Test` (ci.yml)
  - `Frontend Lint, Typecheck & Build` (ci.yml)
  - `Lint, Type-check & Unit Tests` (deploy.yml)
  - `Integration Tests (Decision Engine)` (deploy.yml)
- [ ] If the PR modifies `functions/src/*.ts` callable entry points, the corresponding unit test exists.
- [ ] If the PR modifies `firestore.rules` or `storage.rules`, the rules-test suite passed (`cd functions && npm run test:rules`).
- [ ] If the PR modifies `public-v2/src/lib/firebase.ts` or App Check config, manually verify locally with `cd public-v2 && npm run build` before merging.
- [ ] If the PR adds a new environment variable:
  - Added to `functions/.env.example` (if functions-side) or `public-v2/.env.example` (if frontend-side)
  - Added as a GitHub secret AND written into `deploy.yml`'s "Write functions .env" step (for functions) or passed as a `VITE_*` env in the frontend build step (for frontend)
- [ ] If the PR bumps a dependency with native code (sharp, bcrypt, puppeteer, etc.), verified it builds on Node 24.
- [ ] If the PR bumps Firebase or a Google SDK major version, read the migration guide.

Skip the checklist for doc-only changes (`docs/**`, `*.md`).

---

## 4. Watching a deploy

Once merged:

1. The run appears at `https://github.com/IsaacRomayVida/vidafinance/actions` under workflow "VIDA Platform — Deploy".
2. Watch the `Deploy Firebase (Hosting + Functions + Rules)` job. The tail of the log shows each function's deploy state (`functions[xxx]: Successful update operation.`).
3. If any individual function fails to update, Firebase will flag it in the output but continue the rest. The full deploy is considered a partial failure — see "When a deploy partially fails" below.

You can also monitor live from the CLI:

```bash
gh run watch                              # picks the most recent run
gh run list --workflow=deploy.yml --limit 3
```

---

## 5. Post-deploy verification

Run immediately after the workflow reports success (green):

### 5.1 Automated health check

From your dev laptop (or any CI runner), this takes ~3 seconds:

```bash
for svc in payment-server softcredito notifications pdf-generator ml-service; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://vida-${svc}.railway.app/health")
  printf "%-22s %s\n" "$svc" "$code"
done
curl -s -o /dev/null -w "hosting                %{http_code}\n" https://vida-finance.web.app/
```

All 6 must return **200**. If any return non-200, skip to "Rollback" (§7).

### 5.2 Synthetic user flow

For deploys touching employee-facing code (any `public-v2/src/pages/Employee*.tsx`, `Onboarding.tsx`, `LoanModal`, callable functions starting with `applyForLoan`/`submitLoan`/`acceptOffer`):

1. Open an incognito window → `https://vida-finance.web.app`
2. Log in with the test employee account
3. Click **"Solicitar préstamo"** — the dashboard must load user data within 2 seconds
4. Start a loan application — the modal must open and accept a 5,000 MXN test amount
5. Submit — you should see `pending_review` status. (Don't complete the KYC step unless testing the full e2e flow with a burner ID.)

For deploys touching employer-facing code (any `public-v2/src/pages/Employer*.tsx`, `PayrollUpload.tsx`, or `processPayrollDeduction` function):

1. Log in as a test employer → Dashboard must load employer data
2. Open **"Descontar"** → CSV upload modal must render
3. Upload a 2-row sample CSV → must parse and show both rows

### 5.3 App Check / reCAPTCHA spot-check

Every deploy must preserve reCAPTCHA integration. Verify after deploy:

```bash
# Find the current main bundle name
CHUNK=$(curl -s https://vida-finance.web.app/ | grep -oE 'assets/firebase-[^"]+\.js' | grep -v 'auth-' | head -1)
# Check the site key is embedded
curl -s "https://vida-finance.web.app/$CHUNK" | grep -oE '6L[A-Za-z0-9_-]{38}' | head -1
# Expected: 6LdorcIsAAAAAJ6eGiWpRiwkE_LqTO8_jOrx45Di
```

If that grep returns nothing, `VITE_RECAPTCHA_SITE_KEY` wasn't injected — **the build regressed**. Rollback and see §7.

### 5.4 Structured smoke log

Open Firebase console → Functions → Logs. Filter by `severity >= ERROR` for the last 10 minutes. Expected: zero log entries tagged `VID3-*` error. A burst of `PERMISSION_DENIED` for App Check is OK if it's a low rate and from crawlers; abnormal rates (> 10/min) indicate users are hitting the App Check enforcement incorrectly.

---

## 6. When a deploy partially fails

"Partial failure" = Firebase workflow job succeeds overall but one or more individual functions report a failed update. Symptoms:

- Function logs show old version still running
- `firebase functions:list --project vida-finance` shows mixed `Updated` timestamps

Fix:

```bash
# Run just the failing functions
firebase deploy --only functions:failedFunctionName,functions:otherFailed \
  --project vida-finance --force
```

If the failure was due to a runtime that can't start (e.g. `SyntaxError` in a `require`), the function will stay on the old version. Fix in a new PR; don't force-deploy from laptop.

---

## 7. Rollback

Production rollback takes ~4 minutes. Three paths depending on what broke:

### 7.1 Hosting-only rollback (fastest — 30 seconds)

If the frontend shipped broken but functions are fine:

1. Firebase Console → Hosting → vida-finance.web.app
2. Releases tab → find the previous working release → **⋯ → Roll back**

This reverts only the static assets. Functions and rules are untouched.

### 7.2 Revert the offending commit

For anything more than a frontend bug:

```bash
git checkout main
git pull --ff-only
git revert <offending-sha> --no-edit
git push origin main
```

The revert kicks a fresh deploy that should land in ~7 minutes and restores the previous known-good state. This is the preferred path because it keeps git history honest.

### 7.3 Nuclear (last resort — production only)

If the revert-deploy fails and the site is down, an on-call engineer with Firebase console access can manually roll back functions:

```bash
# List deployed versions (needs gcloud + Firebase Admin SDK access)
gcloud functions list --project vida-finance
# Roll back one function to a prior version
gcloud functions deploy <name> --source=gs://... --project vida-finance
```

This is explicitly **not documented as a regular path** — it bypasses code review and should only be used when the site is hard-down and a `git revert` won't land in time. Always follow up with a proper revert PR after.

---

## 8. Emergency hotfix (bypassing CI)

**Only** when production is down and a PR merge path is blocked (e.g. GitHub Actions is itself down). Requires:

- Local clone on `main` at HEAD
- `firebase-tools` installed
- Access to `FIREBASE_SERVICE_ACCOUNT_PRODUCTION` credentials (in 1Password, vault: "VIDA Finance / Production Secrets")

```bash
# Write credentials
echo "$FIREBASE_SERVICE_ACCOUNT_PRODUCTION" > /tmp/sa.json
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json

# Build + deploy
cd functions && npm ci && npm run build && cd ..
cd public-v2 && npm ci --legacy-peer-deps && VITE_RECAPTCHA_SITE_KEY="$VITE_RECAPTCHA_SITE_KEY" npm run build && cd ..
firebase deploy --only hosting,functions,firestore:rules,storage --project vida-finance

# Clean up
rm /tmp/sa.json
```

After the emergency deploy, **immediately** open a PR with the same fix so git history reflects reality.

---

## 9. Known deploy gotchas

| Symptom | Cause | Fix |
|---|---|---|
| "Permission denied" during functions deploy | Service account token expired or rotated | Regenerate SA key in GCP console → update `FIREBASE_SERVICE_ACCOUNT_PRODUCTION` GitHub secret |
| reCAPTCHA key missing from bundle after deploy | `VITE_RECAPTCHA_SITE_KEY` env not passed to Vite build | Check `.github/workflows/deploy.yml` step "Build frontend (public-v2)" has the `env:` block (PR #347 fixed this) |
| Functions stuck in "Updating" for > 10 min | Cloud Build congestion or a broken build artifact | Wait 5 more minutes, then re-run the deploy step. If repeated, check GCP status page. |
| A single function fails with "memory limit" after deploy | `runWith` config changed | Review PR; may need `memory: '512MB'` or `memory: '1GB'` on that function |
| Frontend build OOM on CI | Vite 8 + Tailwind v4 can spike to ~1.5 GB | Upgrade runner to `ubuntu-latest-4-cores` in `deploy.yml` (not yet needed as of 2026-04-21) |
| Integration tests fail with "METAMAP connection refused" | `METAMAP_MOCK` env var lost during rebase | Ensure `METAMAP_MOCK: 'true'` is present in the integration-test job env block |

---

## 10. Related runbooks

- `incident-response.md` — on-call flow, Slack channels, escalation
- `provider-failover.md` — MetaMap + SoftCrédito + Conekta failure handling
- `scaling.md` — when to bump Cloud Functions concurrency / memory / instances
- `alerting-runbook.md` — what each alert means, severity levels
- `model-retrain.md` — ML model retraining cadence and validation
- `uptime-monitoring.md` — external uptime monitors (UptimeRobot) + PagerDuty routing

---

## Appendix: Key URLs and project IDs

| Resource | Production | Staging |
|---|---|---|
| Hosting | https://vida-finance.web.app | https://vida-finance-staging.web.app |
| Firebase project | `vida-finance` | `vida-finance-staging` |
| payment-server | https://vida-payment-server.railway.app | https://vida-payment-server-staging.railway.app |
| softcredito-adapter | https://vida-softcredito.railway.app | https://vida-softcredito-staging.railway.app |
| notifications | https://vida-notifications.railway.app | https://vida-notifications-staging.railway.app |
| pdf-generator | https://vida-pdf-generator.railway.app | https://vida-pdf-generator-staging.railway.app |
| ml-service | https://vida-ml-service.railway.app | https://vida-ml-service-staging.railway.app |
| reCAPTCHA key (public) | `6LdorcIsAAAAAJ6eGiWpRiwkE_LqTO8_jOrx45Di` | (same, dev allows localhost) |
