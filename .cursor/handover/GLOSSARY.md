# Glossary

VIDA-specific, fintech, and Mexican regulatory terms used throughout the codebase and docs. If a word in this doc appears unfamiliar in code review or chat, look here first.

---

## VIDA-specific

**Stage 0-6** — the 7 stages of the underwriting pipeline:
- **Stage 0:** Employer screening (EFOS, Art. 69, DENUE, REPSE — pass/fail)
- **Stage 1:** Individual identity (RFC format, CURP parse, age 18-65)
- **Stage 2:** Bureau + employment (Belvo IMSS pull, credit bureau via SoftCredito)
- **Stage 3:** Auto-approve gate (6 conditions must all pass for straight-through approval)
- **Stage 4:** Full KYC (MetaMap biometrics, document verification, anomaly detection)
- **Stage 5:** Manual review queue (ops team decides)
- **Stage 6:** Contract generation + signing (pdf-generator → MetaMap Signed Documents)

**Tier 1 / Tier 2 / Tier 3** (in underwriting) — internal risk tiers based on score. Tier 1 = auto-approve, Tier 3 = reject. Middle tier goes to manual review.

**Portal** — one of four frontend sections:
- **Marketing portal** — public pages (`/`, `/employers`, `/employees`, etc.)
- **Employee portal** — role `employee` (`/employee/*`)
- **Employer portal** — role `employer_admin` (`/employer/*`)
- **Ops portal** — roles `ops`/`admin`/`super_admin` (`/ops/*`)

**Cutover day** — launch day (2026-05-31). Flip env flags to production mode (VID3-636).

**Cyrus** — the background agent (AI, Anthropic) that picks up Linear tickets marked `delegate: Cyrus`. Works without supervision.

---

## Mexican regulatory

**SOFOM E.N.R.** — Sociedad Financiera de Objeto Múltiple, Entidad No Regulada. The legal entity VIDA operates as. "Entidad No Regulada" means not supervised by CNBV for solvency, but still regulated for consumer protection (CONDUSEF) and anti-money-laundering (SHCP).

**CNBV** — Comisión Nacional Bancaria y de Valores. Mexico's banking regulator. Supervises regulated SOFOMs and banks; for E.N.R. SOFOMs, owns the registry but not solvency oversight.

**CONDUSEF** — Comisión Nacional para la Protección y Defensa de los Usuarios de Servicios Financieros. Consumer protection regulator. Owns the REUNE registry, publishes CAT standards, handles complaints.

**REUNE** — Registro Único de Usuarios de Entidades Financieras. CONDUSEF's registry of financial-service providers. VIDA must be registered and current.

**SHCP** — Secretaría de Hacienda y Crédito Público. Federal finance ministry. Parent of SAT, CNBV, etc.

**SAT** — Servicio de Administración Tributaria. Mexican IRS. Issues RFC/CURP validation data and the EFOS/Art. 69 blacklists.

**INAI** — Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales. Privacy regulator. Owns aviso de privacidad registry.

**INEGI** — Instituto Nacional de Estadística y Geografía. Publishes DENUE (business registry).

**IMSS** — Instituto Mexicano del Seguro Social. Social security. Source of employment records accessed via Belvo.

**STPS** — Secretaría del Trabajo y Previsión Social. Federal labor ministry. Owns REPSE.

**CAT** — Costo Anual Total. Legally mandated total-cost-of-credit figure shown to consumers. Includes interest + fees + insurance. CONDUSEF standard.

**NOM-151** — the Mexican standard for electronic signatures on regulated documents (incl. loan contracts). MetaMap Signed Documents is NOM-151 compliant.

**LFPDPPP** — Ley Federal de Protección de Datos Personales en Posesión de los Particulares. Mexico's data protection law, enforced by INAI.

---

## Identifiers & documents

**RFC** — Registro Federal de Contribuyentes. Mexican tax ID. 13 chars for individuals (Persona Física), 12 for companies (Persona Moral).
- Individual: 4 letters + 6 digits (birth date) + 3 alphanum homoclave
- Company: 3 letters + 6 digits (incorporation date) + 3 alphanum homoclave

**CURP** — Clave Única de Registro de Población. 18-char personal ID. 4 letters + 6 digits (DOB) + H/M (gender) + 2 letters (state) + 3 consonants + 1 digit/letter + 1 digit.

**CLABE** — Clave Bancaria Estandarizada. 18-digit bank account number for SPEI transfers. `XXXX XXXX XX XXXX XXXX` when formatted.

**SPEI** — Sistema de Pagos Electrónicos Interbancarios. Banxico's real-time interbank transfer system. Sub-minute settlement.

**CoDi** — Cobro Digital. Banxico's consumer-facing QR payment layer on top of SPEI.

**INE** — Instituto Nacional Electoral. Issues voter ID / identity card (credential used in MetaMap document verification).

**EFOS** — Empresas que Facturan Operaciones Simuladas. SAT's blacklist of shell/fraudulent companies. Also called "Lista 69-B" after the SAT article that authorizes it.

**Lista 69-B** — same as EFOS, by its legal article reference.
- **Presunto:** suspected (flag, not reject)
- **Definitivo:** confirmed (hard reject)

**Art. 69** — SAT's public list of taxpayers with fiscal debt (Art. 69 of the Federal Tax Code).

**DENUE** — Directorio Estadístico Nacional de Unidades Económicas. INEGI's business registry. Confirms a company physically operates.

**REPSE** — Registro de Prestadoras de Servicios Especializados u Obras Especializadas. STPS registry of labor-outsourcing-authorized employers. Required for legal payroll-deduction authority.

---

## Providers (third-party)

**MetaMap** — identity verification platform (formerly Mati). Biometrics + AML + PEP + gov-check + NOM-151 signed documents. VIDA's sole KYC provider as of 2026-04-21.

**Belvo** — Latin-American open banking API. VIDA uses it for IMSS employment record pull and (planned) bank account aggregation.

**SoftCredito** — white-label SPEI disbursement + credit bureau adapter. VIDA's SoftCredito adapter sends disbursement orders and queries bureau data.

**SW SAPiens** — SAT-adjacent data provider (sw.com.mx). VIDA uses for EFOS and Art. 69 lookups. Uses username/password → JWT exchange.

**RiskSeal** — digital footprint / fraud signal (email/phone reputation). Currently in mock mode; never tested live.

**Conekta** — Mexican payment processor. Not currently wired into VIDA v1.8. Potential fallback for direct-debit repayment.

**Twilio** — SMS + WhatsApp Business. VIDA uses WhatsApp (primary) for notifications.

**SendGrid** — transactional email. Email fallback + contract delivery.

**Google Document AI** — Google Cloud OCR service. VIDA uses for payroll slip parsing.

**Firebase** — Google's BaaS. Auth, Firestore, Storage, Functions, Hosting, App Check. VIDA runs on it.

**Railway** — platform-as-a-service. VIDA's 6 services run here.

---

## Code / architecture terms

**Callable CF** — Firebase Cloud Function invoked via `httpsCallable()` from the client SDK. Auto-handles auth tokens + App Check. As opposed to HTTP CF (webhook endpoints).

**App Check** — Firebase's anti-abuse layer. Proves requests come from a legitimate app instance (via reCAPTCHA Enterprise for web).

**rate-limit-tier** — internal classification of how strict per-UID rate limiting is for a CF. Tier 1 = 10/min (createLoan), tier 2 = 30/min, tier 3 = 60/min (lookupInvite).

**enforceAppCheck** — CF config flag. When true, requests without a valid App Check token return 401 before any code runs.

**flag-gated** — feature wrapped in an env-var check, safely no-op until the flag is set. Examples: `METAMAP_SIGNING_ENABLED`, `ML_MODE`, `RISKSEAL_MOCK`, `VITE_RECAPTCHA_SITE_KEY`.

**ML_MODE** — env var on ml-service. Values:
- `auto` — model decides
- `shadow` — model runs but decision not used (logging only)
- `manual_review_all` — every loan escalates to Stage 5 regardless of model output (launch default)

**`@/` import alias** — TypeScript path alias for `public-v2/src/`. Configured in `vite.config.ts` and `tsconfig.app.json`.

**Per-portal ErrorBoundary** — as of PR #343, each layout (marketing, employee, employer, admin) plus `/login`, `/onboarding`, and the `/*` catch-all are wrapped in their own `<ErrorBoundary>`. Total 8 boundaries. A crash in one page degrades that route only; the rest of the shell stays usable.

**safeStorage** — `@/lib/safeStorage` module. `safeGetItem`, `safeSetItem`, `safeRemoveItem` with try/catch guards. Use instead of raw `localStorage.*` (which throws in Safari private mode).

---

## Spanish product vocabulary (VIDA's voice)

See `rules/06-mexican-spanish-copy.md` for the full style guide. Quick reference:

| Use | Avoid |
|---|---|
| tú | usted |
| préstamo | crédito, mutuo |
| solicitar | pedir |
| monto | cantidad |
| cuota | mensualidad |
| saldo | balance (Spanglish) |
| plazo | tiempo |
| tasa de interés | intereses |
| nómina | sueldo |
| deducción | descuento |
| empleador | empresa, jefe, patrón |
| empleado, trabajador | obrero |
| Iniciar sesión | login |
| Cerrar sesión | logout |

Never use emoji in UI. Never use "haz clic aquí" for link text. `¿` and `¡` inverted marks required.
