# Incident Response Runbook

> VIDA Finance v1.7 — Operational Runbook

## Severity Levels

| Level | Definition | Response Time | Examples |
|-------|-----------|---------------|----------|
| **SEV-1** | Service down, loans cannot be processed | 15 min | All health checks failing, Firestore outage |
| **SEV-2** | Degraded service, partial functionality lost | 30 min | One microservice down, payment queue stalled |
| **SEV-3** | Non-critical issue, workaround available | 4 hours | PDF generation slow, notification delays |
| **SEV-4** | Minor issue, no user impact | Next business day | Log noise, non-critical alert |

## Alert Playbooks

### Health Check Failure — Any Service

**Alert:** `{service}_health_check_failed`

1. Identify which service is down from the alert payload
2. Check Railway dashboard for the affected service
3. Review logs: `railway logs --service {service-name}`
4. Common causes:
   - **OOM kill** → Scale up memory in Railway, check Redis connection pool
   - **Crash loop** → Check recent deploy, roll back if needed: `railway rollback --service {service-name}`
   - **Port conflict** → Verify `PORT` env var matches expected (3001–3005)
5. If service won't recover, restart: `railway restart --service {service-name}`
6. Verify health endpoint returns 200 after restart

### Payment Server (port 3001)

**Alert:** `payment_queue_stalled` or `disbursement_failed`

1. Check Redis connectivity: verify `REDIS_URL` is reachable
2. Inspect BullMQ queue `vida-disbursements`:
   - Check for failed jobs in Redis
   - Review job error messages
3. Verify Conekta API key is valid — test with a health ping
4. If SPEI disbursement is stuck:
   - Check SoftCrédito adapter (:3002) status
   - Verify `SOFTCREDITO_CLIENT_ID` and `SOFTCREDITO_CLIENT_SECRET` are set
5. **Do NOT retry failed payment jobs blindly** — verify idempotency first

### SoftCrédito Adapter (port 3002)

**Alert:** `softcredito_auth_failure` or `softcredito_timeout`

1. Check SoftCrédito API status page
2. Verify OAuth credentials are valid (not expired)
3. Check rate limits — SoftCrédito may throttle during peak
4. If auth is failing, rotate credentials:
   - Generate new credentials in SoftCrédito portal
   - Update `SOFTCREDITO_CLIENT_ID` and `SOFTCREDITO_CLIENT_SECRET` in Railway
   - Restart service
5. See [Provider Failover Runbook](./provider-failover.md) for extended outages

### Notification Service (port 3003)

**Alert:** `notification_delivery_failed` or `notification_queue_backlog`

1. Check BullMQ queue `vida-notifications` for backlog size
2. Identify channel with failures (WhatsApp, SMS, or Email)
3. **Twilio issues (WhatsApp/SMS):**
   - Verify `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
   - Check Twilio console for account status/billing
   - Review Twilio error codes in logs
4. **SendGrid issues (Email):**
   - Verify `SENDGRID_API_KEY`
   - Check SendGrid dashboard for suppression/bounce issues
5. If queue is backing up, increase concurrency temporarily (see [Scaling Runbook](./scaling.md))

### PDF Generator (port 3004)

**Alert:** `pdf_generation_failed` or `pdf_queue_timeout`

1. Check BullMQ queue `vida-pdfs` — max concurrency is 2
2. Common issues:
   - **Puppeteer crash** → Usually memory — scale up Railway instance
   - **Mifiel e-signature failure** → Verify `MIFIEL_APP_ID` and `MIFIEL_APP_SECRET`
   - **Template rendering error** → Check Handlebars template syntax in logs
3. If Puppeteer keeps crashing, restart service to clear leaked Chrome processes
4. Failed PDFs can be retried safely (idempotent)

### ML Service (port 3005)

**Alert:** `ml_prediction_failed` or `ml_service_unhealthy`

1. Check FastAPI logs for Python tracebacks
2. Common issues:
   - **Model file missing** → Verify model artifacts are deployed
   - **Claude API timeout** → Check `ANTHROPIC_API_KEY`, verify Anthropic status
   - **Redis cache miss** → Feature store may need warming
3. XGBoost/LightGBM errors:
   - Check feature vector shape matches model expectations
   - Verify input validation in prediction endpoint
4. If autoencoder anomaly score spikes, this may be data quality — check upstream providers

### Firestore / Firebase

**Alert:** `firestore_quota_exceeded` or `firebase_auth_error`

1. Check Firebase console for quota usage
2. If write quota exceeded (500 writes/sec default):
   - Enable Firestore burst mode in Firebase console
   - Request quota increase via Google Cloud console
   - Throttle non-critical writes (analytics, shadow logs)
3. Firebase Auth issues:
   - Verify Firebase project configuration
   - Check for blocked users in Firebase Auth console
4. Firestore rules deployment:
   - Verify `review_queue` and `metamap_shadow_log` rules are active
   - Test rules with Firebase emulator before redeploying

### Redis

**Alert:** `redis_oom` or `redis_connection_refused`

1. Check Railway Redis service dashboard
2. If OOM:
   - Flush non-critical caches: rate-limit keys, ML feature cache
   - Increase memory limit in Railway
   - Review key expiration policies
3. If connection refused:
   - Verify `REDIS_URL` is correct across all services
   - Check Railway Redis service status
   - Restart Redis service if unresponsive
4. All BullMQ queues depend on Redis — a Redis outage is SEV-1

## PagerDuty Escalation Policy

Incidents are automatically routed to PagerDuty for SEV-1 and SEV-2. The escalation
policy triggers progressively if the incident is not acknowledged:

| Tier | Target | Escalation Delay | Notification |
|------|--------|-----------------|--------------|
| 1 | **On-call engineer** (weekly rotation) | 10 min | Phone call + push |
| 2 | **Engineering lead** | 10 min | Phone call + push |
| 3 | **CTO** | 10 min | Phone call + push |

- **SEV-1** and **SEV-2** trigger PagerDuty (phone call + push notification)
- **SEV-3** and **SEV-4** go to Slack only (no page)
- Policy loops 2× before stopping — total escalation window: 60 min

### SEV-1 Auto-Detection (PagerDuty Critical)

| Condition | Detection | Dedup Key Pattern |
|-----------|-----------|-------------------|
| All services down | Health monitor: all endpoints unreachable | `vida-vida-infrastructure-all-services-all_services_down` |
| Multiple services down (≥2) | Health monitor: ≥2 endpoints unreachable | `vida-vida-infrastructure-multi-service-multiple_services_down` |
| Redis OOM | Health endpoint reports `redis_status: oom` | `vida-vida-redis-memory-redis_oom` |
| Redis connection refused | Health endpoint reports ECONNREFUSED | `vida-vida-redis-connectivity-redis_connection_refused` |
| Disbursement stalled | 0 completions + jobs waiting for >10 min | `vida-vida-payment-server-disbursements-disbursement_stalled` |

### SEV-2 Auto-Detection (PagerDuty Error)

| Condition | Detection | Dedup Key Pattern |
|-----------|-----------|-------------------|
| Single service down >5 min | Health monitor: one endpoint unreachable >5 min | `vida-{service}-health-check-single_service_down_extended` |
| Error rate >5% | Queue stats: failed/total >5% | `vida-{service}-{component}-error_rate_high` |
| MetaMap outage | Health endpoint reports `metamap_status: down` | `vida-vida-underwriting-service-kyc-metamap_outage` |
| Disbursement failure rate >5% | Queue stats: disbursement failed/total >5% | `vida-vida-payment-server-disbursements-disbursement_failure_rate_high` |
| Model drift PSI >0.25 | Drift monitor: PSI score exceeds threshold | `vida-vida-ml-service-model-drift-error_rate_high` |

### Escalation Path

1. **On-call engineer** — first responder, triages and fixes or escalates
2. **Engineering lead** — SEV-1 and SEV-2 escalation
3. **CTO** — final escalation for unacknowledged incidents
4. **Product owner** — customer communication decisions
5. **Compliance officer** — if incident affects loan data or regulatory compliance

## Post-Incident

1. Create a post-mortem document within 48 hours of SEV-1/SEV-2
2. Identify root cause, timeline, and remediation
3. Update this runbook with any new learnings
4. File follow-up tickets for preventive measures
