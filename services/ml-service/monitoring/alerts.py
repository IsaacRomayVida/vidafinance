"""
Alerting module for ML service drift monitoring.

Sends alerts to Slack and PagerDuty via webhooks.
"""

import logging
import os
import json

import httpx

logger = logging.getLogger("ml_alerts")

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
PAGERDUTY_ROUTING_KEY = os.environ.get("PAGERDUTY_ROUTING_KEY", "")


async def send_slack_alert(message: str, level: str = "warning"):
    if not SLACK_WEBHOOK_URL:
        logger.debug("SLACK_WEBHOOK_URL not set — skipping Slack alert")
        return
    emoji = ":rotating_light:" if level == "critical" else ":warning:"
    payload = {"text": f"{emoji} *VIDA ML Alert* ({level.upper()})\n{message}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(SLACK_WEBHOOK_URL, json=payload)
            if resp.status_code != 200:
                logger.warning("Slack webhook returned %d", resp.status_code)
    except Exception as e:
        logger.warning("Slack alert failed: %s", e)


async def send_pagerduty_alert(summary: str, severity: str = "warning"):
    if not PAGERDUTY_ROUTING_KEY:
        logger.debug("PAGERDUTY_ROUTING_KEY not set — skipping PagerDuty alert")
        return
    payload = {
        "routing_key": PAGERDUTY_ROUTING_KEY,
        "event_action": "trigger",
        "payload": {
            "summary": summary,
            "severity": severity,
            "source": "vida-ml-service",
            "component": "model-drift-monitor",
            "group": "ml",
            "class": "drift",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://events.pagerduty.com/v2/enqueue",
                json=payload,
            )
            if resp.status_code not in (200, 202):
                logger.warning("PagerDuty returned %d: %s", resp.status_code, resp.text)
    except Exception as e:
        logger.warning("PagerDuty alert failed: %s", e)


async def send_drift_alert(alert: dict):
    """Dispatch a drift alert to all configured channels."""
    level = alert.get("level", "warning")
    message = alert.get("message", json.dumps(alert))

    await send_slack_alert(message, level)

    pd_severity = "critical" if level == "critical" else "warning"
    await send_pagerduty_alert(message, pd_severity)
