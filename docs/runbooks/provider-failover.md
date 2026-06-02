# Provider Failover Runbook

> VIDA Finance v1.7 — External Provider Outage Response

## Provider Inventory

| Provider | Service | Port | Purpose | SLA |
|----------|---------|------|---------|-----|
| MetaMap | underwriting-service | 3003 | KYC identity verification | 99.9% |
| Belvo | underwriting-service | 3003 | Open finance / bank account data | 99.5% |
| SoftCrédito | softcredito-adapter | 3002 | SPEI disbursements, payroll deductions | 99.5% |
| RiskSeal | underwriting-service | 3003 | Digital footprint scoring | 99.0% |
| Conekta | payment-server | 3001 | Payment webhook processing | 99.95% |
| Twilio | notification-service | 3003 | WhatsApp + SMS notifications | 99.95% |
| SendGrid | notification-service | 3003 | Email notifications | 99.95% |
| MetaMap | pdf-generator | 3004 | E-signature on contracts | 99.5% |
| Anthropic | ml-service | 3005 | Claude LLM judge | 99.0% |
| Google Document AI | underwriting-service | 3003 | Document OCR | 99.9% |

---

## MetaMap Outage

**Impact:** New loan applications cannot complete KYC identity verification.

### Detection
- Health check failures on underwriting-service
- Webhook delivery failures from MetaMap
- Increased error rates in verification endpoints

### Immediate Response
1. Confirm outage: check [MetaMap status page](https://status.metamap.com)
2. Check if the issue is auth-related (expired webhook secret) vs. service-wide
3. If auth issue:
   - Rotate `METAMAP_WEBHOOK_SECRET` in Railway
   - Verify webhook URL configuration in MetaMap dashboard
   - Restart underwriting-service

### Failover Procedure
1. **Queue incoming applications** — do not reject, hold in `pending_verification` status
2. Enable manual review queue in Ops Dashboard
3. For high-priority applications, use manual document review:
   - Ops team can verify INE/CURP documents manually via Ops Dashboard
   - Flag as `manual_kyc` in Firestore for audit trail
4. Set estimated recovery time and notify ops team via Slack

### Recovery
1. Confirm MetaMap is back (webhook test succeeds)
2. Process queued applications through MetaMap verification
3. Clear `pending_verification` backlog
4. Verify shadow log (`metamap_shadow_log`) is recording correctly

---

## Belvo Outage

**Impact:** Cannot pull bank account data for open-finance underwriting features.

### Detection
- Timeout errors in underwriting-service logs
- Missing bank data in loan applications

### Immediate Response
1. Confirm outage: check Belvo status page
2. Verify `BELVO_SECRET_ID` and `BELVO_SECRET_PASSWORD` are valid

### Failover Procedure
1. **Proceed without open-finance features** — the champion scorecard can function with reduced feature set
2. Adjust model to use bureau-only features:
   - WoE LR v2 has fallback scoring without Belvo features
   - Flag applications as `belvo_unavailable` for post-hoc review
3. Increase manual review threshold — lower auto-approve cutoff by 50 points
4. Notify risk team of degraded underwriting quality

### Recovery
1. Confirm Belvo API responds
2. Re-enrich pending applications with bank data
3. Re-score applications that were approved without Belvo data
4. Restore normal auto-approve threshold

---

## SoftCrédito Outage

**Impact:** Cannot disburse via SPEI or process payroll deductions.

### Detection
- Failed jobs in BullMQ queue `vida-disbursements`
- Auth failures in softcredito-adapter logs
- Timeout errors on SPEI transfer endpoints

### Immediate Response
1. Confirm outage: contact SoftCrédito support
2. Verify OAuth credentials (`SOFTCREDITO_CLIENT_ID`, `SOFTCREDITO_CLIENT_SECRET`)
3. Check if rate-limited vs. full outage

### Failover Procedure
1. **CRITICAL: Loans approved but not disbursed must be tracked carefully**
2. Pause the `vida-disbursements` BullMQ queue (do not clear jobs):
   - Jobs will remain in queue and retry when service recovers
3. For urgent disbursements:
   - Process manually via bank portal (requires finance team)
   - Record manual disbursement in Firestore with `manual_spei` flag
4. Payroll deduction processing:
   - Notify employer partners of delay
   - Queue deduction files for batch processing on recovery
5. Communicate delay to affected borrowers via notification-service

### Recovery
1. Confirm SoftCrédito API responds (test auth + test transfer)
2. Resume `vida-disbursements` queue
3. Monitor queue drain — ensure no duplicate disbursements
4. Reconcile manual disbursements against queue records
5. Process backlogged payroll deduction files

---

## RiskSeal Outage

**Impact:** Missing digital footprint scores for fraud detection.

### Detection
- Errors in underwriting-service calling RiskSeal API
- Missing `risk_seal_score` in application data

### Failover Procedure
1. **Low severity** — RiskSeal is supplementary, not required
2. Proceed with scoring using remaining features
3. Increase autoencoder anomaly threshold sensitivity by 10%
4. Flag applications as `riskseal_unavailable` for enhanced manual review
5. Monitor fraud rates closely during outage

### Recovery
1. Confirm RiskSeal responds
2. Back-fill risk scores for applications processed during outage
3. Restore normal autoencoder threshold

---

## Conekta Outage

**Impact:** Cannot receive payment webhooks (repayments not recorded).

### Detection
- No incoming webhook events on payment-server
- Check Conekta dashboard for failed webhook deliveries

### Failover Procedure
1. Payments may still be processing on Conekta's side
2. Do NOT mark loans as unpaid — webhook delivery may be delayed
3. Monitor Conekta dashboard for successful charges
4. Manually reconcile payments if outage exceeds 4 hours:
   - Export successful charges from Conekta dashboard
   - Update loan statuses in Firestore manually
5. Verify `CONEKTA_WEBHOOK_SECRET` is valid after recovery

### Recovery
1. Conekta will replay failed webhooks automatically
2. Verify no duplicate payment processing
3. Reconcile loan statuses against Conekta records

---

## Twilio Outage (WhatsApp / SMS)

**Impact:** Borrowers don't receive notifications (loan approval, payment reminders, etc.).

### Failover Procedure
1. Notifications are non-blocking — loan processing continues
2. Queue failed notifications in BullMQ `vida-notifications` for retry
3. Switch critical notifications to SendGrid email as backup
4. For urgent borrower communications, use email channel only
5. Monitor queue backlog size

### Recovery
1. Resume notification queue processing
2. Twilio will not replay — manually retry failed jobs from BullMQ
3. Verify WhatsApp Business API template approvals are intact

---

## Anthropic (Claude) Outage

**Impact:** LLM judge unavailable for underwriting decisions.

### Failover Procedure
1. **Non-blocking** — the LLM judge is advisory, not decisive
2. Proceed with champion scorecard (WoE LR v2) decisions only
3. Flag applications as `llm_unavailable` for post-hoc review
4. Monitor for increased false-positive/negative rates without LLM input

### Recovery
1. Confirm Claude API responds
2. Back-fill LLM judge opinions for applications processed during outage
3. Compare decisions made without LLM to LLM-assisted decisions for calibration

---

## General Failover Principles

1. **Never reject a loan application due to a provider outage** — queue or degrade gracefully
2. **Always flag degraded decisions** — mark what data was missing for audit trail
3. **Never auto-retry payments or disbursements blindly** — verify idempotency
4. **Communicate proactively** — notify ops team, employer partners, and borrowers as appropriate
5. **Document everything** — log outage start/end, decisions made, manual interventions
6. **Post-outage reconciliation** — always reconcile data after provider recovery
