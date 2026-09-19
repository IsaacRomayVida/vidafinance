# Rotating INTERNAL_SECRET

`INTERNAL_SECRET` is the shared bearer of service-to-service trust: the Cloud
Functions and five Railway services present it as `x-internal-secret`, and
payment-server, pdf-generator, underwriting-service, softcredito-adapter and
registry-service refuse every `/internal/*` call without it. A sixth service,
ml-service, verifies it on its own endpoints too, and since 2026-09-19 accepts
the same ALT set — see the note under "Who holds the secret" for the two
details specific to it.

Rotating it naively means editing one value in eight places. That cannot be
atomic, and for the length of the rollout some caller still sends the old value
to a callee that already demands the new one. Every one of those calls is a 401
in the middle of a live loan flow — a disbursement, a KYC stage, a contract PDF.

So the verifiers accept a **set**, not a value
(`services/shared/internal-secret.js`):

| Variable | Sent by callers | Accepted by verifiers |
|---|---|---|
| `INTERNAL_SECRET` | yes | yes |
| `INTERNAL_SECRET_ALT` | never | yes, when set |

`ALT` exists only during a rotation. With it, the change becomes three ordered
steps, and at no point is there a value in flight that somebody rejects.

## Who holds the secret

- **GitHub secret `INTERNAL_SECRET`** — the canonical copy. `deploy.yml` and
  `firebase-deploy.yml` write it into `functions/.env`; `railway-setup-env.yml`
  and `sync-registry-funpay-secret.yml` push it into the Railway services.
- **Railway** (project `FunPay` / `production`): payment-server,
  pdf-generator, underwriting-service, softcredito-adapter,
  registry-service-funpay. A variable change redeploys the service.
- **Cloud Functions** — from `functions/.env` at deploy time, so functions only
  pick up a new value on the next production deploy.

`ml-service` also verifies this secret (`services/ml-service/internal_auth.py`),
which makes **six** verifiers, not five. As of 2026-09-19 it participates in the
rollover on the same terms as the other five: `accepted_secrets()` returns the
non-empty values among `ML_INTERNAL_SECRET`, `INTERNAL_SECRET`,
`ML_INTERNAL_SECRET_ALT` and `INTERNAL_SECRET_ALT`, compares every candidate
without short-circuiting, and hashes both sides before `hmac.compare_digest` —
the same shape as `services/shared/internal-secret.js`. Treat it as a sixth
Railway service in every step below.

Two details specific to it. `ML_INTERNAL_SECRET` takes precedence over
`INTERNAL_SECRET` when both are set, matching what `underwriting-service` call
sites already send (`ML_INTERNAL_SECRET || INTERNAL_SECRET`); if you set the ALT
under one name, set it under the name whose primary that service is actually
using. And its boot guard still requires a primary — an ALT alone will not start
the service.

## The rotation

Generate the new value with `openssl rand -base64 48 | tr -d '\n'`, or any
source of ≥32 bytes of entropy. Never paste it into a chat, a commit, a PR or a
job log.

**Step 1 — widen the accepted set.** Set `INTERNAL_SECRET_ALT` = *new* on all
five Railway services. Wait for each redeploy to finish and `/health` to answer.
Everybody now accepts `{old, new}` and everybody still sends `old`; nothing has
changed from a caller's point of view, which is what makes this step safe to
stop at.

**Step 2 — switch what is sent.** In any order:

- Update the GitHub secret `INTERNAL_SECRET` to *new*
  (`gh secret set INTERNAL_SECRET`).
- Set `INTERNAL_SECRET` = *new* and `INTERNAL_SECRET_ALT` = *old* on the five
  Railway services.
- Deploy production so the Cloud Functions pick the new value up. **The deploy
  must be *created* after the secret changed.** A workflow run carries the
  secret values it was given when the run started, so a deploy already in
  flight — or a re-run of an older one — ships the OLD value and reports
  success. This is not theoretical: on 2026-09-18 the deploy triggered by the
  merge began at 11:22, `INTERNAL_SECRET` changed at 11:32, and the functions
  updated at 11:44 still carried the old value. Merge something, or dispatch
  `firebase-deploy.yml` with `environment: production`, and check afterwards.

Order does not matter here: every verifier accepts both values throughout, so a
caller mid-switch is accepted whichever value it holds.

**Step 3 — narrow the accepted set.** Remove `INTERNAL_SECRET_ALT` from all
five services. The old value is now rejected everywhere. Do not skip this: a
rotation that leaves `ALT` set has not retired the old secret, which was the
point.

## Verifying

After each step:

```bash
node scripts/check-production-health.mjs        # 14/14, all services answering
curl -s "$REGISTRY_URL/health"                  # {"status":"ok","db":true}
```

The health endpoints are unauthenticated, so they prove liveness, not auth.

Two checks that prove auth without side effects:

```bash
# Accepted? 400 = the secret got through and the body was rejected; 401 = refused.
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$REGISTRY_URL/internal/entities/resolve" \
  -H 'Content-Type: application/json' -H "x-internal-secret: $(cat new-secret-file)" -d '{}'

# Which value are the deployed functions actually sending? Compare digests,
# never the values themselves.
val=$(gcloud functions describe getSystemHealth --project vida-finance --region us-central1 \
  --format='value(serviceConfig.environmentVariables.INTERNAL_SECRET)')
printf %s "$val" | shasum -a 256 | cut -c1-12
shasum -a 256 < new-secret-file | cut -c1-12
```

Do not run step 3 until those digests match. Also watch for 401s in the Railway
service logs and the functions logs during a real loan flow. A 401 at step 2
means some service never got step 1 — put `ALT` back on it before continuing.

## Rollback

At step 1: remove `ALT`; nothing was sending it.
At step 2: set `INTERNAL_SECRET` back to *old* (GitHub secret and Railway) and
redeploy the functions. `ALT` still holds the other value, so both directions
keep working while you do it.
After step 3: the old value is gone from the accepted set; recovering means
running the rotation again with the values swapped.
