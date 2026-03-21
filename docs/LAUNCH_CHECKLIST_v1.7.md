# VIDA Finance v1.7 Launch Checklist

> **Last updated:** 2026-03-21
> **Release tag:** `v1.7.0`
> **Status:** All items verified

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
