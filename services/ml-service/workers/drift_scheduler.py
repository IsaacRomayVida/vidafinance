"""
Weekly scheduled drift monitoring job.

Runs PSI/CSI checks against the baseline and writes results to the
Firestore `model_monitoring` collection. Designed to run as an asyncio
background task within the FastAPI lifespan.

Schedule: every 7 days (configurable via DRIFT_CHECK_INTERVAL_HOURS env var).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np

logger = logging.getLogger("ml-service.drift-scheduler")

DRIFT_CHECK_INTERVAL_HOURS = int(os.environ.get("DRIFT_CHECK_INTERVAL_HOURS", "168"))  # 7 days

_executor = ThreadPoolExecutor(max_workers=1)


def _get_firestore():
    from services.firestore_client import FirestoreClient
    return FirestoreClient()


def _fetch_recent_scores(firestore) -> list[dict]:
    """Fetch recent loan decisions from Firestore for drift analysis."""
    db = firestore._db
    query = (
        db.collection("loans")
        .where("underwritingModel", "==", "logistic_v1.0")
        .where("status", "in", ["approved", "rejected"])
        .order_by("decidedAt", direction="DESCENDING")
        .limit(1000)
    )
    docs = query.stream()
    return [doc.to_dict() for doc in docs]


def _extract_features_and_scores(loans: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Extract feature matrix and scores from loan documents."""
    from models.drift_monitor import FEATURE_NAMES

    features_list = []
    scores_list = []

    for loan in loans:
        snapshot = loan.get("borrowerSnapshot", {})
        uw_features = loan.get("underwritingFeatures", {})
        score = loan.get("underwritingScore")

        if score is None:
            continue

        # Reconstruct feature vector from stored data
        row = []
        for name in FEATURE_NAMES:
            val = uw_features.get(name, 0.0)
            row.append(float(val))

        features_list.append(row)
        scores_list.append(float(score))

    if not features_list:
        return np.array([]).reshape(0, len(FEATURE_NAMES)), np.array([])

    return np.array(features_list), np.array(scores_list)


def _run_drift_check_sync() -> dict | None:
    """Synchronous drift check — runs in thread pool."""
    from models.drift_monitor import load_baseline, run_drift_check, BASELINE_PATH

    if not os.path.exists(BASELINE_PATH):
        logger.warning("No baseline found at %s — skipping drift check", BASELINE_PATH)
        return None

    try:
        firestore = _get_firestore()
    except Exception as e:
        logger.error("Cannot connect to Firestore: %s", e)
        return None

    loans = _fetch_recent_scores(firestore)
    if len(loans) < 30:
        logger.info("Only %d loans found — need at least 30 for drift check", len(loans))
        return None

    features, scores = _extract_features_and_scores(loans)
    if len(scores) < 30:
        logger.info("Only %d scored loans — need at least 30 for drift check", len(scores))
        return None

    baseline = load_baseline()
    report = run_drift_check(features, scores, baseline)

    # Write to Firestore
    doc_id = datetime.now(timezone.utc).strftime("drift_%Y%m%d_%H%M%S")
    db = firestore._db
    db.collection("model_monitoring").document(doc_id).set({
        **report,
        "type": "drift_check",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    logger.info(
        "Drift check complete: PSI=%.4f, alert=%s, written to model_monitoring/%s",
        report["score_psi"],
        report["alert_level"],
        doc_id,
    )

    return report


async def run_drift_check_async() -> dict | None:
    """Run drift check in a thread pool to avoid blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, _run_drift_check_sync)


async def start_drift_scheduler():
    """
    Background task that runs drift checks on a recurring schedule.

    Waits for the configured interval between checks. First check runs
    after an initial delay of 60 seconds to let the service warm up.
    """
    logger.info(
        "Drift scheduler started — checking every %d hours", DRIFT_CHECK_INTERVAL_HOURS
    )

    # Initial delay to let the service fully start
    await asyncio.sleep(60)

    while True:
        try:
            report = await run_drift_check_async()
            if report:
                if report["alert_level"] == "retrain":
                    logger.warning(
                        "RETRAIN TRIGGER: PSI=%.4f exceeds threshold %.2f",
                        report["score_psi"],
                        0.25,
                    )
                elif report["alert_level"] == "warning":
                    logger.warning(
                        "DRIFT WARNING: PSI=%.4f exceeds threshold %.2f",
                        report["score_psi"],
                        0.10,
                    )
        except Exception as e:
            logger.error("Drift check failed: %s", e, exc_info=True)

        await asyncio.sleep(DRIFT_CHECK_INTERVAL_HOURS * 3600)
