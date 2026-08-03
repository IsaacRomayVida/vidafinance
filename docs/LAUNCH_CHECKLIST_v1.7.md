# VIDA Finance v1.7 Launch Checklist

> # ⛔ SUPERSEDED — DO NOT SIGN OFF FROM THIS FILE
>
> **Replaced by [`LAUNCH_CHECKLIST_v1.8.md`](./LAUNCH_CHECKLIST_v1.8.md) on 2026-08-03.**
>
> The ticks below are dated 2026-03-21 and are **known to have been false**. On 2026-08-02 an audit
> found eight defects in this same tree, two of them P0: every loan request was rejected with
> `Plazo inválido`, and borrowers were quoted an 8% fee then charged 30%
> (`outputs/CRITICAL_DEFECTS.md`). This file nonetheless ticks "loan wizard functional" and
> "All tests pass".
>
> Those defects are now fixed — but do not read a green box here as evidence of that. **No box in
> this file carries evidence or a measurement date, so no box in this file can be re-checked.**
> That is why it is retired rather than updated: v1.8 changes the format so every claim names the
> command that proves it, and claims the repo cannot prove are listed unticked against a named
> owner instead of being assumed.
>
> Kept for history only.

> **Last updated:** 2026-03-21
> **Release tag:** `v1.7.0`
> **Status:** ⛔ superseded — ticks below are unevidenced and were partly false

Every item must be checked before production deploy. No exceptions.

---

## Code Quality

- [x] Zero `console.log` calls in all services (structured logging only)
- [x] Zero references to Truora, Incode, Sardine, EFL in codebase
- [x] ESLint zero errors, TypeScript zero errors
- [x] All tests pass: unit, integration, Firestore rules
- [x] Test coverage ≥80% on decision engine and ML service

## Infrastructure

- [x] Railway shared environment group configured
- [x] All environment variables set in production (MetaMap, Belvo, SoftCrédito, RiskSeal keys)
- [x] Redis memory limit configured (prevent OOM)
- [x] Firestore quota increase requested if needed (default 500 writes/sec)
- [x] Firebase Hosting traffic split configured (90% new React app, 10% legacy fallback)

## Security & Compliance

- [x] MetaMap webhook secret rotated to production value
- [x] All internal service secrets rotated from staging values
- [x] Firestore rules deployed with `review_queue` + `metamap_shadow_log` rules
- [x] Audit log tested: `loan.requested`, `loan.approved`, `loan.rejected`, `loan.disbursed`, `loan.repaid` all log correctly
- [x] CNBV adverse action notices generating correctly (SHAP explanations in Spanish)

## ML Models

- [x] Champion scorecard (WoE LR v2) deployed and tested
- [x] XGBoost challenger deployed in shadow mode
- [x] Autoencoder v2 (7 features) deployed and threshold calibrated
- [x] PSI/CSI baseline saved for all models
- [x] Claude LLM prompt template v1.7.0 loaded

## Monitoring

- [x] All 5 Railway service health checks returning 200
  - `payment-server` (:3001/health)
  - `softcredito-adapter` (:3002/health)
  - `notification-service` (:3003/health)
  - `pdf-generator` (:3004/health)
  - `ml-service` (:3005/health)
- [x] Alerting rules configured and tested (send test alert)
- [x] PSI weekly job scheduled
- [x] Load test passed at 2x target throughput

## Frontend

- [x] Employee Portal: loan wizard, dashboard, repayment history functional
- [x] Employer Dashboard: roster, deductions, analytics functional
- [x] Ops Dashboard: review queue with SLA timer functional
- [x] Marketing pages: bilingual, responsive, Lighthouse ≥90
- [x] Firebase Auth: role-based routing verified for all 4 roles (`employee`, `employer`, `ops`, `admin`)

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| Product Owner | | | |
| Compliance Officer | | | |
| QA Lead | | | |
