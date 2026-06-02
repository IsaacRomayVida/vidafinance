# VIDA Monitoring Setup

Prometheus-compatible metrics exposed at `/metrics` on every Railway service + a Grafana dashboard for visualization.

## Architecture

```
┌─────────────────┐                 ┌──────────────────┐
│ Railway service │──/metrics──────▶│ Grafana Cloud    │
│ (6 services)    │  (scraped)      │ (dashboard UI)   │
└─────────────────┘                 └──────────────────┘
        │
        └─ exposes vida_* metrics via prom-client
```

## What's instrumented

Each Railway service on `observant-miracle` exposes:

- **vida_http_request_duration_seconds** — histogram, per route + method + status code
- **vida_business_events_total** — counter: `loan_disbursed`, `loan_repaid`, `disbursement_failed`, etc.
- **vida_external_provider_duration_seconds** — Belvo, SoftCredito, MetaMap, Conekta latency
- **vida_queue_depth** — BullMQ queue stats (waiting, active, failed)
- **vida_circuit_breaker_state** — 0=closed, 1=half-open, 2=open
- **vida_process_resident_memory_bytes** — Node RSS
- **vida_process_cpu_seconds_total** — CPU time
- Default Node metrics: event loop lag, GC duration, heap size

## Production setup (one-time)

### 1. Register with Grafana Cloud

- Sign up at [grafana.com](https://grafana.com) (free tier is 10k series)
- Create a new Prometheus data source — note the **Remote Write endpoint**, username, and API key

### 2. Configure scraping via Grafana Agent (or Prometheus)

Option A (simpler) — Grafana Agent on a small VM:

```yaml
# agent-config.yaml
server:
  log_level: info

metrics:
  global:
    scrape_interval: 30s
  configs:
    - name: vida-prod
      scrape_configs:
        - job_name: vida-payment-server
          static_configs:
            - targets: ['payment-server-production-b9b8.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
        - job_name: vida-softcredito-adapter
          static_configs:
            - targets: ['softcredito-adapter-production.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
        - job_name: vida-notification-service
          static_configs:
            - targets: ['notification-service-production-f49e.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
        - job_name: vida-pdf-generator
          static_configs:
            - targets: ['pdf-generator-production-1a31.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
        - job_name: vida-ml-service
          static_configs:
            - targets: ['ml-service-production-f949.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
        - job_name: vida-underwriting-service
          static_configs:
            - targets: ['underwriting-service-production.up.railway.app:443']
          scheme: https
          metrics_path: /metrics
      remote_write:
        - url: https://prometheus-prod-XX.grafana.net/api/prom/push
          basic_auth:
            username: "<grafana_cloud_instance_id>"
            password: "<grafana_cloud_api_key>"
```

Option B — Prometheus self-hosted with remote_write to Grafana Cloud.

### 3. Import the dashboard

- Grafana → Dashboards → Import → Upload JSON file
- Select `docs/monitoring/grafana-dashboard.json` from this repo
- Set data source to the Prometheus source you created in step 1
- Save

### 4. Configure alerts

The dashboard has alert-compatible panels. Create alert rules in Grafana:

| Alert | Query | Threshold |
|---|---|---|
| Service down | `up{job=~"vida-.*"} == 0` | for 1m |
| Error rate | `sum by (service) (rate(vida_http_request_duration_seconds_count{status_code=~"5.."}[5m]))` | > 0.1 for 5m |
| p95 latency | `histogram_quantile(0.95, sum by (service, le) (rate(vida_http_request_duration_seconds_bucket[5m])))` | > 2 for 10m |
| Disbursement failures | `sum(increase(vida_business_events_total{event="disbursement_failed"}[5m]))` | > 0 |
| Circuit breaker open | `sum(vida_circuit_breaker_state == 2)` | > 0 for 1m |

Notification channels: Slack #vida-alerts (via `SLACK_WEBHOOK_URL`) + PagerDuty (via `PAGERDUTY_ROUTING_KEY`). Already plumbed — see VID3-629.

## Local development

```bash
# Start service with metrics
cd services/payment-server
npm install
npm run dev

# Verify /metrics is live
curl http://localhost:3001/metrics | head -30
```

## Adding new business events

In any service:

```js
const { businessEvent } = require('../shared/metrics');

// On success:
businessEvent('loan_disbursed', 'vida-payment-server');

// On failure:
businessEvent('disbursement_failed', 'vida-payment-server');
```

New events show up in the "Business Events" panel within the scrape interval (30s).

## Known gaps

- **ml-service (Python)**: prom-client is Node-only. Python service needs `prometheus-client` library added separately — see `services/ml-service/monitoring/` for the hook point.
- **Firebase Cloud Functions**: use Google Cloud Monitoring, not this Prometheus stack. Separate dashboard at console.firebase.google.com.
- **Ops Review Queue backlog**: Firestore-sourced, surfaced via the `/ops/review-queue` UI (VID3-566). Not on Prometheus.

