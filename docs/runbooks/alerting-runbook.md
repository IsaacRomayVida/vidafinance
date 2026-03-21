# VIDA Finance — Alerting Runbook

Quick reference for oncall engineers responding to production alerts.

---

## 1. Decision Engine Error Rate > 1%

**Alert:** `Decision engine error rate is X% — threshold: 1%`
**Severity:** Critical
**Source:** `vida-ml-service` / `vida-underwriting` queue

### Diagnosis
1. Check ML service health: `curl $ML_SERVICE_URL/health`
2. Check underwriting queue stats: `curl -H 'x-internal-secret: $SECRET' $PAYMENT_SERVER_URL/internal/queue-stats`
3. Check ML service logs on Railway for stack traces
4. Verify Redis connectivity from ML service

### Common Causes
- ML model file corrupted or missing (`models/underwriting_v1.joblib`)
- Redis connection failure causing BullMQ job failures
- Firestore write failures (permission or quota)
- SoftCrédito bureau API timeout cascading into job failures

### Resolution
1. If model file issue → redeploy ML service (Railway will rebuild from Dockerfile)
2. If Redis issue → check Railway Redis service status, restart if needed
3. If Firestore quota → check Firebase console for quota alerts
4. If SoftCrédito timeout → the worker has graceful degradation; check if the error is in bureau enrichment or model prediction

### Escalation
If error rate persists > 5 min after mitigation → page ML team lead

---

## 2. MetaMap API P95 Latency > 10s

**Alert:** `MetaMap API P95 latency > 10s`
**Severity:** Warning
**Source:** `vida-underwriting-service`

### Diagnosis
1. Check MetaMap status page for incidents
2. Check underwriting service logs for timeout patterns
3. Verify network connectivity from Railway to MetaMap API

### Common Causes
- MetaMap API degradation or outage
- Network issues between Railway and MetaMap
- Request payload size issues (large document uploads)

### Resolution
1. If MetaMap outage → enable bypass mode (underwriting continues without KYC, flagged for manual review)
2. If intermittent → increase timeout threshold temporarily
3. Monitor MetaMap status page for resolution ETA

### Escalation
If MetaMap down > 30 min → notify compliance team (KYC backlog building)

---

## 3. SPEI Disbursement Failure Rate > 0.5%

**Alert:** `SPEI disbursement failure rate is X% — threshold: 0.5%`
**Severity:** Critical
**Source:** `vida-payment-server` / `vida-disbursements` queue

### Diagnosis
1. Check payment server health: `curl $PAYMENT_SERVER_URL/health`
2. Check queue stats: `curl -H 'x-internal-secret: $SECRET' $PAYMENT_SERVER_URL/internal/queue-stats`
3. Check SoftCrédito adapter health: `curl $SOFTCREDITO_ADAPTER_URL/health`
4. Check Firestore `incident_log` collection for recent disbursement errors

### Common Causes
- SoftCrédito SPEI API outage or maintenance
- Invalid CLABE numbers in borrower data
- SoftCrédito auth token expiry
- Network issues between payment server and SoftCrédito adapter

### Resolution
1. If SoftCrédito API down → failed jobs will auto-retry (5 attempts, exponential backoff)
2. If CLABE validation issue → check borrower data in Firestore, flag for manual correction
3. If auth token issue → SoftCrédito adapter will auto-refresh token; restart adapter if stuck
4. After > 5 retries, loans are marked `disbursement_error` in Firestore — require manual intervention

### Escalation
If failure rate > 2% → page finance ops team immediately (borrower impact)

---

## 4. Stage 5 Queue Depth > 50

**Alert:** `Queue underwriting depth is X (threshold: 50)`
**Severity:** Warning
**Source:** Health check queue_depth

### Diagnosis
1. Check all service health endpoints for worker status
2. Check if underwriting worker is running: ML service health → `worker` field
3. Check Redis memory usage on Railway

### Common Causes
- ML service worker crashed or stuck
- Redis memory pressure causing slow operations
- Surge in loan applications (legitimate traffic spike)
- SoftCrédito bureau enrichment causing slow processing

### Resolution
1. If worker stopped → restart ML service on Railway
2. If Redis memory → check Railway Redis metrics, consider scaling
3. If traffic spike → monitor; worker will catch up (concurrency=5)
4. If bureau timeout → worker has graceful degradation, should still process

### Escalation
If queue > 100 for > 15 min → page ML team (potential data loss risk)

---

## 5. Service Health Check "down" > 2 min

**Alert:** `Service X has been DOWN for Y minutes`
**Severity:** Critical
**Source:** Health monitor

### Diagnosis
1. Check Railway dashboard for the affected service
2. Check Railway deployment logs for crash loops
3. Check if Redis is healthy (all services depend on it)
4. Verify environment variables are set correctly

### Common Causes
- Deployment failure (bad code push, missing env var)
- Redis outage cascading to all services
- Railway infrastructure issue
- Memory/CPU limits exceeded (especially pdf-generator with Puppeteer)

### Resolution
1. If recent deploy → rollback on Railway to previous deployment
2. If Redis down → restart Redis service on Railway; all services will reconnect
3. If resource limits → scale up on Railway
4. If crash loop → check Railway logs for root cause, fix and redeploy

### Escalation
- Single service down > 5 min → page service owner
- Multiple services down → page infrastructure lead
- All services down → page CTO

---

## 6. PSI > 0.25 (Model Drift)

**Alert:** `Model drift detected: PSI=X (threshold: 0.25) — full retrain required`
**Severity:** Critical
**Source:** `vida-ml-service` / drift monitor

### Diagnosis
1. Check latest drift report: `curl -H 'x-internal-secret: $SECRET' $ML_SERVICE_URL/monitor/drift/latest`
2. Review CSI scores per feature to identify which features drifted
3. Check Firestore `ml_drift_reports` collection for trend
4. Compare current application population vs training data demographics

### Common Causes
- Shift in borrower demographics (new employer segments, salary ranges)
- Seasonal patterns (payroll timing, industry hiring cycles)
- Changes in bureau data availability or scoring methodology
- New product features changing the loan application mix

### Resolution

**If PSI 0.10–0.25 (Warning):**
1. Recalibrate Platt scaling on the logistic regression output
2. Monitor for 1 more week to see if drift stabilizes

**If PSI > 0.25 (Critical):**
1. Trigger full model retrain pipeline
2. Collect last 90 days of scoring data from Firestore `underwriting_decisions`
3. Retrain model with updated feature distributions
4. Validate on holdout set before deploying
5. Update `models/underwriting_v1.joblib` and deploy ML service
6. Update reference data in Firestore `ml_reference_data/underwriting_v1`

### Escalation
PSI > 0.25 → notify ML team lead and Head of Credit within 24h

---

## General Troubleshooting

### Checking Service Logs
```bash
# Railway CLI
railway logs --service vida-payment-server
railway logs --service vida-ml-service
```

### Restarting a Service
```bash
# Railway CLI
railway service restart --service vida-payment-server
```

### Checking Redis
```bash
# Connect to Redis via Railway
railway connect vida-redis
> PING
> INFO memory
> LLEN bull:vida-underwriting:wait
```

### Health Dashboard
Open `services/shared/dashboard.html` in a browser and configure the base URL to point to your Railway deployment.

---

## Alert Channels

| Channel | Purpose |
|---------|---------|
| Slack `#vida-alerts` | All warnings and critical alerts |
| PagerDuty | Critical alerts → oncall engineer |
| Firestore `incident_log` | Persistent audit trail |
| Firestore `ml_drift_reports` | Drift monitoring history |

## Environment Variables for Alerting

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for alert channel |
| `PAGERDUTY_ROUTING_KEY` | PagerDuty Events API v2 routing key |
| `POLL_INTERVAL_MS` | Health monitor poll interval (default: 60000) |
| `DRIFT_CHECK_INTERVAL_SECONDS` | Drift check interval (default: 604800 = 7 days) |
