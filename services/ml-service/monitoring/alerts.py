"""
Alerting module for VIDA ML service.

Sends structured alerts to Slack (#vida-alerts) and PagerDuty.

Alert levels:
  - warning  -> Slack only (model fallback, rate limits, etc.)
  - critical -> Slack + PagerDuty page (health down, Redis lost, Firestore failure)

Rate limiting: max 1 alert per key per 5 minutes (deduplication).

Environment variables:
  SLACK_WEBHOOK_URL      - Slack incoming webhook URL (#vida-alerts)
  PAGERDUTY_ROUTING_KEY  - PagerDuty Events API v2 routing key
"""

import logging
import os
import json
import time

import httpx

logger = logging.getLogger("ml_alerts")

SERVICE_NAME = "vida-ml-service"
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
PAGERDUTY_ROUTING_KEY = os.environ.get("PAGERDUTY_ROUTING_KEY", "")

# ── Rate limiting ────────────────────────────────────────────────────
DEDUP_WINDOW_S = 5 * 60  # 5 minutes
_recent_alerts: dict[str, float] = {}


def _is_duplicate(alert_key: str) -> bool:
    now = time.time()
    last = _recent_alerts.get(alert_key)
    if last and now - last < DEDUP_WINDOW_S:
        return True
    _recent_alerts[alert_key] = now
    # Prune old entries
    if len(_recent_alerts) > 500:
        expired = [k for k, ts in _recent_alerts.items() if now - ts > DEDUP_WINDOW_S]
        for k in expired:
            del _recent_alerts[k]
    return False


# ── Runbook links ────────────────────────────────────────────────────
RUNBOOK_BASE = "https://linear.app/vidateam/document"
RUNBOOKS = {
    "health_down": f"{RUNBOOK_BASE}/runbook-service-health-down-d1a2b3",
    "disbursement_failed": f"{RUNBOOK_BASE}/runbook-disbursement-failed-e4f5a6",
    "redis_lost": f"{RUNBOOK_BASE}/runbook-redis-connection-lost-b7c8d9",
    "webhook_stuck": f"{RUNBOOK_BASE}/runbook-webhook-stuck-f0a1b2",
    "firestore_failure": f"{RUNBOOK_BASE}/runbook-firestore-write-failure-c3d4e5",
    "fraud_high": f"{RUNBOOK_BASE}/runbook-fraud-score-critical-a6b7c8",
}


# ── Slack ────────────────────────────────────────────────────────────
async def send_slack_alert(
    message: str,
    level: str = "warning",
    *,
    service: str = SERVICE_NAME,
    alert_type: str = "",
    runbook: str | None = None,
):
    if not SLACK_WEBHOOK_URL:
        logger.debug("SLACK_WEBHOOK_URL not set - skipping Slack alert")
        return
    emoji = ":rotating_light:" if level == "critical" else ":warning:"
    svc_label = f" `{service}`" if service else ""
    type_label = f" - {alert_type}" if alert_type else ""
    runbook_url = RUNBOOKS.get(runbook) if runbook else None

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"{emoji} *VIDA Alert* ({level.upper()}){svc_label}{type_label}\n\n{message}",
            },
        }
    ]
    if runbook_url:
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {"type": "mrkdwn", "text": f":book: <{runbook_url}|Runbook>"}
                ],
            }
        )

    payload = {
        "blocks": blocks,
        "text": f"{emoji} VIDA Alert ({level.upper()}){svc_label}: {message}",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(SLACK_WEBHOOK_URL, json=payload)
            if resp.status_code != 200:
                logger.warning("Slack webhook returned %d", resp.status_code)
    except Exception as e:
        logger.warning("Slack alert failed: %s", e)


# ── PagerDuty ────────────────────────────────────────────────────────
async def send_pagerduty_alert(
    summary: str,
    severity: str = "warning",
    *,
    source: str = SERVICE_NAME,
    component: str = "unknown",
    runbook: str | None = None,
):
    if not PAGERDUTY_ROUTING_KEY:
        logger.debug("PAGERDUTY_ROUTING_KEY not set - skipping PagerDuty alert")
        return
    payload = {
        "routing_key": PAGERDUTY_ROUTING_KEY,
        "event_action": "trigger",
        "payload": {
            "summary": summary,
            "severity": severity,
            "source": source,
            "component": component,
            "group": "vida",
            "class": "monitoring",
        },
    }
    runbook_url = RUNBOOKS.get(runbook) if runbook else None
    if runbook_url:
        payload["links"] = [{"href": runbook_url, "text": "Runbook"}]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://events.pagerduty.com/v2/enqueue", json=payload
            )
            if resp.status_code not in (200, 202):
                logger.warning(
                    "PagerDuty returned %d: %s", resp.status_code, resp.text
                )
    except Exception as e:
        logger.warning("PagerDuty alert failed: %s", e)


# ── Unified alert dispatcher ────────────────────────────────────────
async def alert(
    *,
    message: str,
    level: str = "warning",
    service: str = SERVICE_NAME,
    component: str = "unknown",
    alert_type: str = "",
    runbook: str | None = None,
    dedup_key: str | None = None,
):
    """
    Send a structured alert.

    level='warning' -> Slack only
    level='critical' -> Slack + PagerDuty
    """
    key = dedup_key or f"{service}:{alert_type or component}"
    if _is_duplicate(key):
        return

    if level == "critical":
        await send_slack_alert(
            message, level, service=service, alert_type=alert_type, runbook=runbook
        )
        await send_pagerduty_alert(
            message, "critical", source=service, component=component, runbook=runbook
        )
    else:
        await send_slack_alert(
            message, level, service=service, alert_type=alert_type, runbook=runbook
        )


# ── Convenience helpers ──────────────────────────────────────────────


async def alert_model_fallback(reason: str):
    """ML model fallback from champion to challenger."""
    await alert(
        message=f"ML model fallback from champion -> challenger: {reason}",
        level="warning",
        component="ml-model",
        alert_type="model_fallback",
    )


async def alert_redis_lost():
    """Redis connection lost (PagerDuty incident)."""
    await alert(
        message="Redis connection lost",
        level="critical",
        component="redis",
        alert_type="redis_lost",
        runbook="redis_lost",
    )


async def alert_firestore_failure(failure_rate: float):
    """Firestore write failure rate exceeded (PagerDuty incident)."""
    await alert(
        message=f"Firestore write failure rate is *{failure_rate * 100:.1f}%* (threshold: 5%)",
        level="critical",
        component="firestore",
        alert_type="firestore_failure",
        runbook="firestore_failure",
    )


async def alert_rate_limit(api_name: str):
    """Rate limit hit on external API."""
    await alert(
        message=f"Rate limit hit on `{api_name}`",
        level="warning",
        component="external-api",
        alert_type="rate_limit",
        dedup_key=f"{SERVICE_NAME}:rate_limit:{api_name}",
    )


async def alert_5xx(status_code: int, path: str):
    """5xx error on a public endpoint."""
    await alert(
        message=f"HTTP {status_code} on `{path}`",
        level="warning",
        component="http",
        alert_type="5xx",
        dedup_key=f"{SERVICE_NAME}:5xx:{path}",
    )


# ── Legacy compat (used by drift scheduler) ─────────────────────────
async def send_drift_alert(alert_data: dict):
    """Dispatch a drift alert to all configured channels."""
    level = alert_data.get("level", "warning")
    message = alert_data.get("message", json.dumps(alert_data))

    await alert(
        message=message,
        level=level,
        component="model-drift-monitor",
        alert_type="drift",
    )
