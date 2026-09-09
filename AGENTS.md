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
  Never cross their data, domains, or credentials. FunPay's portal used to
  live on `alfa.funtrip.mx` — Funtrip's domain — because `funpay.mx` was
  not on Cloudflare and could not be automated. It is now, so the portal
  moved to `alfa.funpay.mx` and handed that domain back. The one remaining
  shared resource is the Cloudflare API token, which lives in the
  vidatravel repo and now sees all four zones; DNS for `funpay.mx` is
  created with that repo's `cloudflare-dns.yml` workflow.

## Surfaces (what to register in the Suena review portal)

FunPay is five surfaces, not one. Served behind the holding portal at
`https://alfa.suena.ch/funpay/`; the paths below are relative to that.

| Surface | Path | Frame | Sign in with |
|---|---|---|---|
| Sitio público | `web/` | escritorio **and** móvil | nothing — it is anonymous |
| App (empleado) | `app/` | móvil only | employee account below |
| Portal empleado | `web/login` → `web/employee` | escritorio | employee account below |
| Portal empleador | `web/login` → `web/employer` | escritorio | employer account below |
| Consola ops | `web/login` → `web/ops` | escritorio | ops account below |

The app is a phone app: framing it at desktop width shows a stretched
phone layout, not a web product. The other four are web and should offer
both sizes. Shortcuts worth registering: `app/?screen=RequestLoan`,
`app/?screen=Loans`, and for the web portals `web/employee/apply`,
`web/employer/payroll`, `web/ops/review-queue`.

| Thing | Value |
|---|---|
| Canonical | https://alfa.suena.ch/funpay/ (behind Cloudflare Access) |
| Origin | https://funpay-alfa.web.app — serves the build; **not** gated, and it redirects a browser to the canonical portal |
| Mount point | one build serves one prefix. `holding_prefix` sets `EXPO_PORTAL_BASE` and `VITE_BASE_PATH` together; a build made for `/funpay` renders blank anywhere else, with a 200 |
| Rebuild/redeploy | Actions → `deploy-team-portal.yml`, **dispatched against the branch** (`--ref mobile-motion-pass`), inputs `ref`, `mode`, `holding_prefix=/funpay`, `web_launch_mode` |
| Read feedback | dispatch `deploy-team-portal.yml` with `mode=feedback` — newest 25 reports print to the run summary (SA-authenticated; there is no anonymous read) |
| Build identity | the portal footer shows `portal <git-sha> · <UTC time>`; quote it in bug reports |
| Screen identity | every app screen sets `document.title` to `FunPay · <pantalla>`, so a report can name the surface it came from |

## QA fixtures (the only sanctioned test identities)

- Employer code: **FUNQA1** → employer `qa-funpay-demo-employer`
  ("FunPay QA — interno, no usar", status pending_verification).
- Test emails: anything `@demo-diagnostic.funpay.mx`.
- **Employee**: `qa-ui-1788773545173@demo-diagnostic.funpay.mx` /
  `QaUi-2026-Prueba1` ("María Prueba QA", $4,500 line, identity
  unverified — cannot reach money paths, by design).
- **Employer admin**: `qa-empleador@demo-diagnostic.funpay.mx` /
  `FunPay-Empleador-TDIUEdULUH`. Its uid *is* the employer document id
  (`qa-funpay-demo-employer`), which is how the employer screens find
  their data — it can only ever see the QA company's employees.
- **Ops**: `qa-ops@demo-diagnostic.funpay.mx` / `FunPay-Ops-M89jUYWQRW`.
  Not a fixture: `ops` reads every borrower's file and `approveEmployer`
  writes to production. Look and navigate; never approve, reject or
  disperse.
- None of these use OTP — email and password only, no SMS code.
- New QA borrowers: register through the wizard with FUNQA1 + a demo
  email. Never verify identity (MetaMap) for a fixture.

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
| `deploy-team-portal.yml` | Publish portal / register domain / read feedback | `ref`, `mode`, `domain` |
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
