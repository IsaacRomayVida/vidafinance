"""
Scheduled job runner for ML monitoring tasks.

Runs drift checks on a configurable interval (default: weekly).
Uses asyncio sleep loop — no external cron dependency.
"""

import asyncio
import logging
import os

logger = logging.getLogger("drift_scheduler")

# Default: 7 days in seconds
DRIFT_CHECK_INTERVAL = int(os.environ.get("DRIFT_CHECK_INTERVAL_SECONDS", str(7 * 24 * 3600)))


async def drift_scheduler(firestore_db, alert_callback=None):
    """Run drift check on a recurring interval."""
    from monitoring.drift import run_weekly_drift_job

    # Wait 60s after startup before first check
    await asyncio.sleep(60)

    while True:
        try:
            logger.info("Running scheduled drift check")
            result = await run_weekly_drift_job(firestore_db, alert_callback)
            logger.info("Drift check result: %s", result)
        except Exception as e:
            logger.error("Drift scheduler error: %s", e)

        await asyncio.sleep(DRIFT_CHECK_INTERVAL)
