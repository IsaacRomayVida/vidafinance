# FunPay — Agent Interface Guide

Machine-facing guide for external agent systems (suena console and
similar) interacting with FunPay's testing portal, feedback pipeline,
and build automation. Humans: see README.md; Claude-in-repo: CLAUDE.md.

## Ground rules (non-negotiable)

- **This is a production money system.** Agents may read, test-register,
  and file feedback. Agents must NEVER execute or simulate real payments,
  transfers, or disbursements, and must never create borrowers outside
  the QA fixtures below.
- FunPay (vidafinance) is a separate business from Funtrip (vidatravel).
  Never cross their data, domains, or credentials — the sole sanctioned
  exception is the `alfa.funtrip.mx` DNS record, which lives on the
  funtrip.mx Cloudflare zone by explicit owner decision.

## The team-testing portal

| Thing | Value |
|---|---|
| Portal URL | https://alfa.funtrip.mx (canonical) · https://funpay-app.web.app (direct) |
| What it is | The mobile app (react-native-web export) rendered in a phone frame, live against production Firebase |
| App-only URL | https://funpay-app.web.app/app/ (no frame — for automated UI drives) |
| Rebuild/redeploy | GitHub Actions → `deploy-team-portal.yml` (inputs: `ref` branch, `mode` deploy\|domain) |

## QA fixtures (the only sanctioned test identities)

- Employer code: **FUNQA1** → employer `qa-funpay-demo-employer`
  ("FunPay QA — interno, no usar", status pending_verification).
- Test emails: anything `@demo-diagnostic.funpay.mx`.
- Standing QA borrower: `qa-ui-1788773545173@demo-diagnostic.funpay.mx` /
  `QaUi-2026-Prueba1` ("María Prueba QA", $4,500 line, identity
  unverified — cannot reach money paths, by design).
- New QA borrowers: register through the portal wizard with FUNQA1 + a
  demo email. Never verify identity (MetaMap) for a fixture.

## Feedback pipeline (`qa_feedback` Firestore collection)

**Write (anonymous, what the portal's Feedback button does):**

```
POST https://firestore.googleapis.com/v1/projects/vida-finance/databases/(default)/documents/qa_feedback
Content-Type: application/json

{"fields":{
  "screen":   {"stringValue":"Home"},          // ≤120 chars
  "comment":  {"stringValue":"…"},             // 1..1500 chars, required
  "name":     {"stringValue":"Agent suena-3"}, // ≤80 chars, may be ""
  "ua":       {"stringValue":"…"},             // ≤200 chars, may be ""
  "createdAt":{"timestampValue":"2026-09-07T12:00:00Z"}
}}
```

Exactly these five keys — extra keys, missing `comment`, or oversized
values are rejected by security rules. Update/delete are impossible for
all clients.

**Read (privileged):** rules allow reads only to `ops` role users; agent
systems should read via Admin SDK using the project service account
(GitHub secret `FIREBASE_SERVICE_ACCOUNT_PRODUCTION`) or ask a
Claude/ops session for a digest. There is no anonymous read.

## Build & asset automation (GitHub Actions, repo IsaacRomayVida/vidafinance)

| Workflow | Purpose | Key inputs |
|---|---|---|
| `build-android.yml` | EAS .apk (installable build) | `profile`: preview\|production |
| `deploy-team-portal.yml` | Publish the portal | `ref`, `mode` |
| `generate-brand-motion.yml` | fal.ai brand assets (Seedance/FLUX) | `kind`: motion\|splash · `prompt` · `extra_args` |
| `seed-qa-employer.yml` | (Re)create the FUNQA1 fixture | — |

Builds auto-increment versionCode; the running build's version shows in
the app's Login footer (e.g. `v0.10.0`).

## Current security posture (temporary, tracked)

App Check is unenforced on Auth, Firestore, and the callables
`lookupEmployerByCode`, `checkEmailAvailability`, `getLoanConfig` until
Play Integrity is registered for `mx.funpay.app` (VID3-676). The money
callables (`requestLoan`, `generatePaymentLink`) remain enforced and
identity-gated. Do not depend on the relaxed state; it will be re-armed.

## Brand constants (for any agent generating assets or copy)

Freedom is the brand: the papalote (teal #194445 / gold #a28657 kite),
dawn-sky ground, dignified aspirational Mexican family life, Spanish
informal tú. Every generated visual ends on the papalote in the sky.
