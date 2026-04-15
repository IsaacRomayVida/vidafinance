"""
Alerting module for ML service drift monitoring.

Sends alerts to Slack and PagerDuty via webhooks with SEV-1/SEV-2
incident classification, deduplication keys, and enriched payloads.
"""

import logging
import os
import re
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("ml_alerts")

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
PAGERDUTY_ROUTING_KEY = os.environ.get("PAGERDUTY_ROUTING_KEY", "")
NODE_ENV = os.environ.get("NODE_ENV", "development")

# Severity mapping aligned with VIDA runbooks
SEVERITY_LABELS = {
    "critical": "SEV-1",
    "error": "SEV-2",
    "warning": "SEV-3",
    "info": "SEV-4",
}

SEVERITY_EMOJI = {
    "critical": ":rotating_light:",
    "error": ":fire:",
    "warning": ":warning:",
    "info": ":information_source:",
}


def generate_dedup_key(
    source: str, component: str, condition_id: str | None = None
) -> str:
    """Generate a deduplication key for PagerDuty."""
    parts = ["vida", source, component]
    if condition_id:
        parts.append(condition_id)
    raw = "-".join(parts).lower()
    return re.sub(r"[^a-z0-9-]", "-", raw)


async def send_slack_alert(message: str, severity: str = "warning"):
    if not SLACK_WEBHOOK_URL:
        logger.debug("SLACK_WEBHOOK_URL not set — skipping Slack alert")
        return
    emoji = SEVERITY_EMOJI.get(severity, ":warning:")
    label = SEVERITY_LABELS.get(severity, severity.upper())
    payload = {"text": f"{emoji} *VIDA ML Alert* ({label})\n{message}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(SLACK_WEBHOOK_URL, json=payload)
            if resp.status_code != 200:
                logger.warning("Slack webhook returned %d", resp.status_code)
    except Exception as e:
        logger.warning("Slack alert failed: %s", e)


async def send_pagerduty_alert(
    summary: str,
    severity: str = "warning",
    source: str = "vida-ml-service",
    component: str = "unknown",
    dedup_key: str | None = None,
    custom_details: dict | None = None,
    links: list | None = None,
) -> dict | None:
    """Send alert to PagerDuty Events API v2 with enriched payload."""
    if not PAGERDUTY_ROUTING_KEY:
        logger.debug("PAGERDUTY_ROUTING_KEY not set — skipping PagerDuty alert")
        return None

    resolved_dedup_key = dedup_key or generate_dedup_key(source, component)
    label = SEVERITY_LABELS.get(severity, severity)

    pd_links = []
    for link in links or []:
        if isinstance(link, str):
            pd_links.append({"href": link, "text": "Runbook"})
        else:
            pd_links.append(link)

    payload = {
        "routing_key": PAGERDUTY_ROUTING_KEY,
        "event_action": "trigger",
        "dedup_key": resolved_dedup_key,
        "payload": {
            "summary": f"[{label}] {summary}",
            "severity": severity,
            "source": source,
            "component": component,
            "group": "ml",
            "class": "drift",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "custom_details": {
                "environment": NODE_ENV,
                "severity_label": label,
                **(custom_details or {}),
            },
        },
        "links": pd_links,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://events.pagerduty.com/v2/enqueue",
                json=payload,
            )
            if resp.status_code not in (200, 202):
                logger.warning("PagerDuty returned %d: %s", resp.status_code, resp.text)
            return {
                "status": (
                    "success" if resp.status_code == 202 else f"http_{resp.status_code}"
                ),
                "dedup_key": resolved_dedup_key,
            }
    except Exception as e:
        logger.warning("PagerDuty alert failed: %s", e)
        return None


async def resolve_pagerduty_incident(dedup_key: str) -> bool:
    """Resolve a PagerDuty incident by dedup key."""
    if not PAGERDUTY_ROUTING_KEY or not dedup_key:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://events.pagerduty.com/v2/enqueue",
                json={
                    "routing_key": PAGERDUTY_ROUTING_KEY,
                    "event_action": "resolve",
                    "dedup_key": dedup_key,
                },
            )
            return resp.status_code in (200, 202)
    except Exception as e:
        logger.warning("PagerDuty resolve failed: %s", e)
        return False


async def send_drift_alert(alert: dict):
    """Dispatch a drift alert to all configured channels with severity classification."""
    level = alert.get("level", "warning")
    message = alert.get("message", str(alert))
    psi_score = alert.get("psi_score")

    # Classify severity: PSI > 0.25 is SEV-2 (model needs retrain)
    if level == "critical" or (psi_score and psi_score > 0.25):
        severity = "error"  # SEV-2
    else:
        severity = "warning"  # SEV-3

    await send_slack_alert(message, severity)

    # Only page for SEV-1 and SEV-2
    if severity in ("critical", "error"):
        await send_pagerduty_alert(
            summary=message,
            severity=severity,
            source="vida-ml-service",
            component="model-drift-monitor",
            dedup_key=generate_dedup_key(
                "vida-ml-service", "model-drift", "drift_detected"
            ),
            custom_details={
                "psi_score": psi_score,
                "alert_type": alert.get("type", "drift"),
            },
            links=["https://docs.vida.mx/runbooks/alerting-runbook#psi-drift"],
        )
