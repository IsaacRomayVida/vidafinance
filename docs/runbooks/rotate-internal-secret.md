# Rotating INTERNAL_SECRET

`INTERNAL_SECRET` is the shared bearer of service-to-service trust: the Cloud
Functions and five Railway services present it as `x-internal-secret`, and
payment-server, pdf-generator, underwriting-service, softcredito-adapter and
registry-service refuse every `/internal/*` call without it.

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

`ml-service` is not in this set: it has its own `ML_INTERNAL_SECRET`.

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
- Deploy production so the Cloud Functions pick the new value up (a deploy of
  `main`, or re-run the last `VIDA Platform — Deploy`).

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

The health endpoints are unauthenticated, so they prove liveness, not auth. For
auth, watch for 401s in `services/*/logs` (Railway) and in the functions logs
during a real loan flow, or run the QA loan fixture end to end. A 401 at step 2
means some service never got step 1 — put `ALT` back on it before continuing.

## Rollback

At step 1: remove `ALT`; nothing was sending it.
At step 2: set `INTERNAL_SECRET` back to *old* (GitHub secret and Railway) and
redeploy the functions. `ALT` still holds the other value, so both directions
keep working while you do it.
After step 3: the old value is gone from the accepted set; recovering means
running the rotation again with the values swapped.
