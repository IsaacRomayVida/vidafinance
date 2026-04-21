# First Week — exactly what to do

Seven days of action. Every item has an owner (Isaac / Cursor / Cyrus / Claude-chat) and a time estimate.

---

## Day 1 (tomorrow morning) — kick everything off

**Budget: 2.5 focused hours. Does the most compounding work.**

### 1. [Isaac, 15 min] Resolve VID3-663 — ML decision
Open the ticket. Reply:
> Path B. Set `ML_MODE=manual_review_all`. Every loan flows through Stage 5 manual review until the model is retrained with real originations data. Post-launch: add retraining ticket to backlog (target 90 days post-launch with real data).

Mark Done.

### 2. [Isaac, 45 min] Register reCAPTCHA Enterprise
Follow `PROVIDER_TRACKER.md` → Google/Firebase. Get the `6L...` key, drop it in GitHub Secrets as `VITE_RECAPTCHA_SITE_KEY`, push anything to trigger a deploy. Mark VID3-676 Done.

Verify after deploy completes:
```bash
# Sign in at https://vida-finance.web.app/login with a test account
# Open DevTools Network tab
# Submit any form that hits a callable CF
# Expect: 200, not 401
```

### 3. [Isaac, 30 min] Send 3 vendor emails
Copy-paste from `PROVIDER_TRACKER.md` to:
- **MetaMap support** — Signed Documents + prod creds
- **Belvo account manager** — production tier activation
- **SoftCredito account manager** — capacity + escalation

Log the send-time in a notes file. You're starting 3 clocks (1-7 days each).

### 4. [Isaac, 30 min] Twilio WhatsApp templates
Twilio Console → Content Template Builder. Submit all 5 templates from `PROVIDER_TRACKER.md` → Twilio. All Category: **Utility**, language `es_MX`. Meta approval clock starts.

### 5. [Isaac, 30 min] SendGrid templates
SendGrid Dashboard → Dynamic Templates. Create all 5 from `PROVIDER_TRACKER.md` → SendGrid. No approval wait; once saved, they're live.

**End-of-day state:**
- ML decision made and shipped (VID3-663 ✅)
- reCAPTCHA live and CFs work for real users (VID3-676 ✅)
- 3 vendor clocks ticking (MetaMap, Belvo, SoftCredito)
- Meta WhatsApp approval clock ticking (24-48h)
- Email templates saved and usable

---

## Day 2 — counsel + RiskSeal + employer screening re-verify

### 1. [Isaac, 60 min] Email regulatory counsel
Send this exact email (adjust to your counsel's name):

> Asunto: Revisión pre-lanzamiento VIDA Finance — 31 de mayo
>
> Hola [Nombre],
>
> Lanzamos VIDA Finance a producción el 31 de mayo. Necesito tu revisión y firma por escrito en los siguientes puntos antes del 24 de mayo:
>
> 1. **Metodología CAT** — cálculo del Costo Anual Total que mostramos en el flujo de solicitud y en el contrato. Debe cumplir con requerimientos CONDUSEF.
>
> 2. **REUNE** — confirmar que nuestra inscripción en el Registro Único de Usuarios de Entidades Financieras está vigente y correcta.
>
> 3. **Aviso de privacidad** — el publicado en el sitio debe corresponder al registrado ante INAI. Adjunto ambos.
>
> 4. **Contrato de crédito** — adjunto el template. Cumplimiento NOM-151 para firma electrónica vía MetaMap. Cláusulas de autorización de descuento por nómina.
>
> 5. **Identificador SOFOM** en footer y comunicaciones. Verificar wording:
>    > "VIDA Finance SOFOM, E.N.R. Sociedad Financiera de Objeto Múltiple, Entidad No Regulada. La inscripción en el Registro no implica certificado de solvencia."
>
> 6. **Due diligence de empleadores** — ver adjunto VID3-719. Decidimos dejar la validación SAT directa y apoyarnos en 4 señales independientes (EFOS + Art. 69 + DENUE + REPSE + RiskSeal). Necesito tu opinión por escrito sobre si esto cumple con la diligencia razonable CNBV/CONDUSEF, o si debemos reintegrar un check SAT.
>
> 7. **Política de cobranza** — documento del proceso para loans en mora 30/60/90 días. Lo borraré si ya existe; si no, necesito plantilla.
>
> Disponibilidad de tu lado: ¿1h esta semana para repasarlos?
>
> Gracias,  
> Isaac

Attach: current contract template (generate via pdf-generator service), aviso de privacidad, VID3-719 ticket export.

### 2. [Isaac, 15 min] Email RiskSeal support
Copy-paste from `PROVIDER_TRACKER.md` → RiskSeal. Starts the verification clock.

### 3. [Cursor or Cyrus, 90 min] Re-verify SW SAPiens + REPSE
Assign VID3-640 follow-up. Task:
1. Verify `SW_USER` + `SW_PASSWORD` env vars on Railway underwriting-service
2. Run manual test: `railway run bash` → `node -e "require('./src/sw-client').check69B('GBI830721KT7').then(console.log)"`
3. If auth fails: diagnose (usually credential expiration)
4. Same for REPSE with `curl -sS $REPSE_URL?rfc=GBI830721KT7`
5. File a follow-up fix PR if either is broken

### 4. [Isaac, 30 min] First employer outreach
Identify 5 target employers — warehouses, maquiladoras, service companies, 200-1500 employees. Reach out for a 15-min call this week. This is the single most important thing you do for launch.

---

## Day 3 — first vendor responses start rolling in

### If MetaMap responded with prod creds

[Claude chat or Cursor, 30 min]  
- Set `METAMAP_CLIENT_ID`, `METAMAP_CLIENT_SECRET`, `METAMAP_BASE_URL=https://api.metamap.com` on Railway `pdf-generator` and `underwriting-service`
- `firebase functions:secrets:set METAMAP_WEBHOOK_SECRET`
- Register webhook URL at MetaMap dashboard
- Redeploy affected services
- Keep `METAMAP_SIGNING_ENABLED=false` for now
- Run VID3-660 sandbox E2E

### If SoftCredito responded

- Capture capacity/SLA doc in your notes
- If they flagged rate limits, add Redis-based rate limiter to `softcredito-adapter` service (file ticket)

### If first employer replied with interest

Prioritize above everything else. Book the call. Prepare a 15-min pitch.

### [Cursor, 2 hours] VID3-635 — deploy runbook
Have Cursor draft `docs/RUNBOOK_v1.8.md`. Structure:

1. Pre-deploy checklist
2. Deploy order (CFs first, then Railway services, then hosting)
3. Smoke test steps
4. Rollback procedure per component
5. Escalation contacts
6. Known issues playbook

Review, commit, merge.

---

## Day 4-5 — E2E test kickoff

### [Cyrus, 8 points = ~2 days] VID3-632 — Full E2E test

Delegate to Cyrus with the Linear ticket. Test personas:
- Employer: "Nearshoring Manufacturing SA" with RFC NMS010203ABC
- Employee: adult with valid CURP, employed at NMS
- Loan: MXN 3,000, 30-day term

Happy path: employer signup → invite employee → employee signs up → applies for loan → gets approved → signs contract → gets disbursement → first payroll deduction → full repayment → can apply again.

Cyrus writes the test. You run it when it's ready. Expect 2-3 iterations.

---

## Day 6-7 — load + security + Twilio templates approved

### If Twilio templates approved (by end of day 2-3 usually)

[Cursor, 30 min]  
- Copy Content SIDs to Railway `notification-service`
- Run VID3-628 notification E2E suite

### [Cyrus, 5 points = ~1 day] VID3-633 — Load test
k6 at 2× projected peak. 26 loans/hour sustained for 1 hour against staging. Capture results, identify bottlenecks.

### [Isaac + Cyrus, 8 points = ~2 days] VID3-634 — Security audit
- Cyrus runs automated: Snyk, npm audit, pip-audit, trufflehog, OWASP ZAP against staging
- Isaac reviews findings, fixes criticals, files post-launch tickets for lows
- Manual pen test from Isaac or contracted pen-tester

---

## End of week 1 — where you should be

- ✅ All Isaac-only fast tasks done (VID3-663, VID3-676, templates submitted, vendor emails out, counsel engaged)
- ✅ Deploy runbook drafted
- ✅ First vendor response processed (likely MetaMap or SoftCredito first)
- ✅ E2E test scaffolded, first test run attempted
- ✅ At least 1 employer call booked or completed
- 🟡 Waiting on Belvo contract (~1 week cycle)
- 🟡 Waiting on counsel review (~2-3 weeks cycle)

If all above is true: **you are on track for 2026-05-31 launch.** The remaining 4 weeks are for testing, vendor follow-up, counsel review, and cutover prep.

If any are NOT true: flag to yourself which slipped and why. Adjust week 2 plan accordingly.

---

## What Cursor/Claude-chat/Cyrus does while you're doing founder work

All of these can run in parallel:
- A11y PR B + C (VID3-715) — form labels + aria-labels
- Deploy runbook writing (VID3-635)
- E2E test scaffolding (VID3-632)
- SW SAPiens + REPSE re-verification
- Any bug triage that comes up
- Vendor-response wiring as creds arrive

Your job is vendor management and business development. The engineering can run without you 85% of the time.
