# Provider Tracker

Every third-party we depend on. Status as of **2026-04-21**.

## Legend
- ✅ Live and verified end-to-end
- 🟡 Integrated but not verified live
- 🟠 Credentials pending
- 🔴 Blocking launch
- ⚪ Self-serve, no vendor response needed

---

## CRITICAL PATH

### 🔴 Google / Firebase — App Check (reCAPTCHA Enterprise)
**What they do:** Bot/abuse protection on every callable Cloud Function. Without it, the `enforceAppCheck: true` flag means all real-user CF calls return 401.  
**Status:** ⚪ Self-serve. Not done.  
**Action (Isaac only):**
1. Firebase Console → `vida-finance` project → App Check → Register web app
2. Provider: **reCAPTCHA Enterprise** (checkbox, not v3 score-based)
3. Google Cloud Console → Security → reCAPTCHA Enterprise → Create key
   - Platform: Website  
   - Domain: `vida-finance.web.app` + custom domain if you have one
4. Copy site key (starts with `6L...`)
5. GitHub → repo settings → Secrets → Actions → add `VITE_RECAPTCHA_SITE_KEY = 6L...`
6. Trigger "VIDA Platform — Deploy" workflow (push anything to main)

**Time:** 30 min. **Unblocks:** literally everything. Linear: **VID3-676**.

---

### 🟠 MetaMap — KYC + e-signature
**What they do:** Individual identity verification (selfie + INE) AND NOM-151-compliant e-signature of loan contracts. Replaces both Verifik and Mifiel (both removed).  
**Status:** Sandbox creds set, production creds not yet obtained. `METAMAP_SIGNING_ENABLED=false` flag-gated.  
**Action (Isaac only):** Email sales/support:

> Subject: Producción — confirmar Signed Documents + credenciales
>
> Hola,
>
> Lanzamos VIDA Finance a producción el 31 de mayo. Necesito:
>
> 1. Confirmar que nuestra cuenta tiene el add-on **Signed Documents** activo (firma NOM-151 de contratos de crédito).
> 2. Credenciales de producción: Client ID + Client Secret.
> 3. Webhook signing secret de producción.
> 4. Configurar webhook hacia: `https://us-central1-vida-finance.cloudfunctions.net/metamapWebhook`
> 5. Activar eventos: `verification.completed` + `document.signed`.
> 6. Volumen esperado mes 3: ~2,000 verificaciones/mes.
>
> Gracias,  
> Isaac

**Time:** 1-3 day vendor cycle.  
**When creds arrive:** Set `METAMAP_CLIENT_ID`, `METAMAP_CLIENT_SECRET` on Railway `pdf-generator` + `underwriting-service`. `firebase functions:secrets:set METAMAP_WEBHOOK_SECRET`. Run sandbox E2E. Flip `METAMAP_SIGNING_ENABLED=true`.  
**Linear:** VID3-659, VID3-660, VID3-632. **Unblocks:** launch.

---

### 🟠 Twilio — WhatsApp Business
**What they do:** WhatsApp messaging — primary notification channel for Mexican tier-1 workers (higher read rate than email).  
**Status:** API key set, templates not submitted. 24-48h Meta approval per template.  
**Action (Isaac only):** Twilio Console → Messaging → Content Template Builder. Submit 5 templates:

1. **`vida_employer_invite`** (Utility)  
   `Hola {{1}}, tu empleador {{2}} te invitó a VIDA Finance, donde puedes solicitar préstamos descontados de tu nómina. Regístrate aquí (válido 30 días): {{3}}`

2. **`vida_loan_approved`** (Utility)  
   `Tu préstamo de {{1}} fue aprobado. Firma tu contrato aquí: {{2}}`

3. **`vida_loan_disbursed`** (Utility)  
   `Depositamos {{1}} en tu cuenta. Puede tardar hasta 60 segundos en aparecer.`

4. **`vida_payroll_deducted`** (Utility)  
   `Tu cuota de {{1}} fue descontada de esta nómina. Saldo restante: {{2}}`

5. **`vida_loan_rejected`** (Utility)  
   `No pudimos aprobar tu solicitud en este momento. {{1}}`

All Spanish (Mexico) `es_MX`. All Category: **Utility** (NOT Marketing — different approval path).

**Time:** 45 min submit + 24-48h wait per template.  
**When approved:** Copy Content SIDs (start `HX...`). Railway `notification-service`: `TWILIO_INVITE_TEMPLATE_SID=HX...` etc.  
**Linear:** VID3-675, VID3-628.

---

### 🟠 SendGrid — transactional email
**What they do:** Email fallback when WhatsApp fails + transactional emails with attachments (contract PDF).  
**Status:** API key set, templates not created.  
**Action (Isaac, self-serve, no wait):** SendGrid Dashboard → Email API → Dynamic Templates → create 5 templates matching the Twilio ones:

| Template | Subject | Variables |
|---|---|---|
| `employee_invited` | `{{employerName}} te invitó a VIDA` | `fullName`, `employerName`, `signupUrl` |
| `loan_approved` | `Tu préstamo fue aprobado` | `amount`, `contractUrl` (+ PDF attachment) |
| `loan_disbursed` | `Depositamos tu préstamo` | `amount`, `clabeLast4` |
| `payroll_deducted` | `Cuota descontada de tu nómina` | `amount`, `remaining` |
| `loan_rejected` | `Actualización de tu solicitud` | `reason` |

**Time:** 1-2 hours.  
**When done:** Copy Template IDs (start `d-`). Railway `notification-service`: `SENDGRID_INVITE_TEMPLATE_ID=d-...` etc.  
**Linear:** VID3-675.

---

### 🟠 Belvo — IMSS employment verification
**What they do:** Pulls real IMSS employment records (employer RFC, position, salary, tenure) — Stage 2 of underwriting. Currently pointed at sandbox.  
**Status:** Sandbox working. Production tier not activated.  
**Action (Isaac only):** Email account manager:

> Subject: Paso a producción — IMSS employment verification
>
> Hola,
>
> Lanzamos el 31 de mayo. Necesito:
>
> 1. Activación del tier de producción para `employment_record`.
> 2. Credenciales de producción: BELVO_SECRET_ID + BELVO_SECRET_PASSWORD.
> 3. Pricing + descuentos por volumen. Estimado mes 3: ~2,000 consultas/mes.
> 4. Documento de retención/privacidad (lo necesita CONDUSEF).
> 5. Diferencias sandbox vs producción que debamos anticipar.
> 6. Contacto de soporte durante horas hábiles.

**Time:** 1 week contract cycle.  
**When creds arrive:** Railway `underwriting-service`: `BELVO_SECRET_ID`, `BELVO_SECRET_PASSWORD`, `BELVO_BASE_URL=https://api.belvo.com` (not sandbox).  
**Linear:** VID3-618, VID3-632.

---

### 🟡 SoftCredito — SPEI disbursement
**What they do:** Sends SPEI transfers to borrower CLABE accounts on loan approval.  
**Status:** Production creds already set. Never load-tested or capacity-confirmed.  
**Action (Isaac only):** Email account manager:

> Subject: Verificación pre-lanzamiento — capacidad y soporte
>
> Hola,
>
> Lanzamos el 31 de mayo. Necesito:
>
> 1. Confirmar capacidad para ~67 disbursements/día peak, ~2,000/mes mes 3.
> 2. Rate limits en el endpoint SPEI.
> 3. Diferencias sandbox vs producción.
> 4. Escalation path si un SPEI queda stuck en horas hábiles.
> 5. Acceso a dashboard de operaciones.
> 6. Confirmar IDs activos:
>    - SOFTCREDITO_PRODUCT_ID=`5a9308440ci16a09a8a07fn230icl6nc`
>    - SOFTCREDITO_APPLICATION_ID=`9LotFodQ7H3m80UWR15qv9phyozmx1Q5y`

**Time:** 1-3 day email exchange.  
**Linear:** no explicit ticket — file one only if response surfaces issues.

---

## EMPLOYER SCREENING STACK

### ✅ DENUE (INEGI business registry)
**Status:** Live and verified end-to-end (2026-04-21, PR #345).  
**Key:** `DENUE_API_KEY` set on Railway `underwriting-service` production.  
**Endpoint:** `https://www.inegi.org.mx/app/api/denue/v1/consulta/BuscarEntidad/{nombre}/{entidad}/{pag}/{pag}/{token}`  
**Verified with:** `checkDENUE("GRUPO BIMBO", "09")` → real record returned.

### 🟡 SW SAPiens — EFOS (Lista 69-B) + Art. 69
**What they do:** SAT-derived blacklists — EFOS (shell companies/tax evaders), Art. 69 (published fiscal debt).  
**Status:** Auth was broken when last checked (invalid JSON from `/authenticate`). Credentials likely set. Not verified end-to-end.  
**Action:** Isaac verify `SW_USER` + `SW_PASSWORD` are set on Railway `underwriting-service`. Then run a manual test:
```bash
railway service underwriting-service
railway run bash
node -e "require('./src/sw-client').check69B('GBI830721KT7').then(console.log)"
```
If it fails, file a ticket with the error and I'll fix.  
**Linear:** part of VID3-640 (needs re-verification).

### ⚪ REPSE (STPS labor registry)
**What they do:** Confirms employer is registered as a labor-authorized outsourcing provider.  
**Status:** Public STPS endpoint, no auth. Last seen failing on URL construction.  
**Action:** Verify `REPSE_URL` is set correctly on Railway. `curl -sS $REPSE_URL?rfc=GBI830721KT7` should return JSON.  
**Linear:** part of VID3-640 (re-verification).

### 🟠 RiskSeal — digital footprint / fraud signal
**What they do:** Score + risk level based on email/phone digital footprint. Stage 0 fraud gate.  
**Status:** Code exists. Never tested against live API. Currently flag-gated with `RISKSEAL_MOCK=true`.  
**Action (Isaac only):** Email RiskSeal support:

> Subject: Live integration verification
>
> Hi,
>
> We're VIDA Finance (Mexico SOFOM) integrating your `latam-1.riskseal.io` endpoint for fraud signal. Pre-launch, I need:
>
> 1. Confirm our API key is active and production-provisioned.
> 2. A known test identity we can query via `checkDigitalFootprint()` to verify a real `score` + `risk_level`.
> 3. Expected latency p50/p99.
> 4. Rate limits.

**When verified:** Flip `RISKSEAL_MOCK=false` on Railway `underwriting-service`, replace `RISKSEAL_API_KEY=PENDING_CONTRACT` with real key.  
**Linear:** VID3-713.

---

## REMOVED PROVIDERS (do not reintroduce)

### ❌ Verifik (SAT taxpayer status) — REMOVED 2026-04-21 (PR #346)
- Stage 1 individual SAT check rejected tier-1 workers unfairly (suspendido personal RFCs are normal)
- Stage 0 employer SAT check replaced by transitive coverage (EFOS + Art. 69 both SAT-sourced)
- Counsel review filed: **VID3-719** — sign-off pending before launch

### ❌ Signzy — never integrated (was Verifik fallback, removed with Verifik)

### ❌ Mifiel — REMOVED 2026-04-18 (PR #308→VID3-644)
- MetaMap handles both KYC AND e-signature now
- Do not add a separate e-sig provider

---

## INFRASTRUCTURE

### Firebase (Google)
- **Project:** `vida-finance`
- **Billing:** Blaze plan active, Isaac's account
- **Services:** Auth, Firestore, Storage, Functions, Hosting, App Check
- **Secrets:** Set via `firebase functions:secrets:set` (METAMAP_WEBHOOK_SECRET lives here)

### Railway
- **Project:** `observant-miracle` (id `1ad040b4-6f0b-4530-9f58-0a1ef5e89c75`)
- **6 services:** softcredito-adapter, payment-server, pdf-generator, notification-service, underwriting-service, ml-service
- **Outbound IP:** `162.220.232.99` (whitelist this with vendors if they ask)
- **Prod environment ID:** `441caff4-8cc1-401f-93e2-30c49fe5d2d9`

### GitHub
- **Repo:** `IsaacRomayVida/vidafinance`
- **Actions:** Auto-deploys on push to main via "VIDA Platform — Deploy" workflow
- **Secrets that matter:** `VITE_RECAPTCHA_SITE_KEY` (pending), `FIREBASE_TOKEN`, `RAILWAY_TOKEN`

---

## REGULATORY / LEGAL

### CONDUSEF
- **Status:** SOFOM E.N.R. registered. REUNE registration status: **needs verification**.
- **Action:** Counsel confirms REUNE is current; file amendments if needed.

### CNBV
- **Status:** SOFOM registration active.
- **Disclaimer in footer:** "VIDA Finance SOFOM, E.N.R. Sociedad Financiera de Objeto Múltiple, Entidad No Regulada. La inscripción en el Registro no implica certificado de solvencia."
- **Action:** Counsel verify exact wording matches registration.

### INAI (privacy)
- **Aviso de privacidad** must match what's filed. Counsel verify.

### Regulatory counsel
- **Action (Isaac only):** Email your regulatory counsel with the full checklist — see `FIRST_WEEK.md` for the draft email. **Start today** — this is the 2-3 week cycle.
- **Linear:** VID3-719 (counsel sign-off on dropped SAT check).
