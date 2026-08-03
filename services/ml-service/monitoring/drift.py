"""
PSI / CSI model-drift monitoring using evidently-ai.

Runs weekly as a scheduled job. Compares the current week's score distribution
and input-feature distributions against the reference (training) dataset.

Alert thresholds:
  PSI > 0.10 → recalibrate Platt scaling
  PSI > 0.25 → full retrain trigger
"""

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from evidently.report import Report
from evidently.metrics import (
    ColumnDriftMetric,
    DatasetDriftMetric,
)

logger = logging.getLogger("drift_monitor")

FEATURE_COLUMNS = [
    "employment_tenure_months",
    "monthly_salary",
    "pay_frequency_encoded",
    "loan_to_salary_ratio",
    "employer_industry_encoded",
    "principal_amount",
    "bureau_score",
    "has_bureau_record",
]
SCORE_COLUMN = "prediction_score"

PSI_WARN_THRESHOLD = 0.10  # recalibrate Platt scaling
PSI_ALERT_THRESHOLD = 0.25  # full retrain


def compute_psi(reference: np.ndarray, current: np.ndarray, bins: int = 10) -> float:
    """Population Stability Index between two score distributions."""
    eps = 1e-6
    breakpoints = np.linspace(0, 1, bins + 1)
    ref_counts = np.histogram(reference, bins=breakpoints)[0] / len(reference) + eps
    cur_counts = np.histogram(current, bins=breakpoints)[0] / len(current) + eps
    return float(np.sum((cur_counts - ref_counts) * np.log(cur_counts / ref_counts)))


def compute_csi(reference: pd.Series, current: pd.Series, bins: int = 10) -> float:
    """Characteristic Stability Index for a single feature."""
    eps = 1e-6
    combined = pd.concat([reference, current])
    breakpoints = np.linspace(combined.min(), combined.max(), bins + 1)
    ref_counts = np.histogram(reference, bins=breakpoints)[0] / len(reference) + eps
    cur_counts = np.histogram(current, bins=breakpoints)[0] / len(current) + eps
    return float(np.sum((cur_counts - ref_counts) * np.log(cur_counts / ref_counts)))


def run_drift_check(
    reference_df: pd.DataFrame,
    current_df: pd.DataFrame,
) -> dict:
    """
    Run PSI on prediction scores and CSI on each input feature.
    Also runs evidently's DatasetDriftMetric plus a per-column
    ColumnDriftMetric for each feature, for detailed reporting.

    Both DataFrames must contain FEATURE_COLUMNS + SCORE_COLUMN.
    """
    results = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "reference_size": len(reference_df),
        "current_size": len(current_df),
        "psi": {},
        "csi": {},
        "alerts": [],
        "evidently_drift": {},
    }

    if len(current_df) < 10:
        results["message"] = "Insufficient current data for drift analysis"
        return results

    # PSI on prediction score
    if SCORE_COLUMN in reference_df.columns and SCORE_COLUMN in current_df.columns:
        psi_value = compute_psi(
            reference_df[SCORE_COLUMN].values,
            current_df[SCORE_COLUMN].values,
        )
        results["psi"]["score"] = round(psi_value, 4)

        if psi_value > PSI_ALERT_THRESHOLD:
            results["alerts"].append(
                {
                    "level": "critical",
                    "metric": "PSI",
                    "value": round(psi_value, 4),
                    "threshold": PSI_ALERT_THRESHOLD,
                    "action": "full_retrain",
                    "message": f"PSI={psi_value:.4f} > {PSI_ALERT_THRESHOLD} — full model retrain required",
                }
            )
        elif psi_value > PSI_WARN_THRESHOLD:
            results["alerts"].append(
                {
                    "level": "warning",
                    "metric": "PSI",
                    "value": round(psi_value, 4),
                    "threshold": PSI_WARN_THRESHOLD,
                    "action": "recalibrate_platt",
                    "message": f"PSI={psi_value:.4f} > {PSI_WARN_THRESHOLD} — recalibrate Platt scaling",
                }
            )

    # CSI on each input feature
    for col in FEATURE_COLUMNS:
        if col in reference_df.columns and col in current_df.columns:
            csi_value = compute_csi(reference_df[col], current_df[col])
            results["csi"][col] = round(csi_value, 4)

            if csi_value > PSI_ALERT_THRESHOLD:
                results["alerts"].append(
                    {
                        "level": "critical",
                        "metric": "CSI",
                        "feature": col,
                        "value": round(csi_value, 4),
                        "threshold": PSI_ALERT_THRESHOLD,
                        "message": f"CSI({col})={csi_value:.4f} — significant feature drift",
                    }
                )

    # Evidently report: dataset-level verdict plus per-column drift detail
    try:
        feature_cols = [
            c
            for c in FEATURE_COLUMNS
            if c in reference_df.columns and c in current_df.columns
        ]
        all_cols = feature_cols + (
            [SCORE_COLUMN]
            if SCORE_COLUMN in reference_df.columns
            and SCORE_COLUMN in current_df.columns
            else []
        )
        ref_subset = reference_df[all_cols].copy()
        cur_subset = current_df[all_cols].copy()

        report = Report(
            metrics=[
                DatasetDriftMetric(),
                *[ColumnDriftMetric(column_name=col) for col in all_cols],
            ]
        )
        report.run(reference_data=ref_subset, current_data=cur_subset)
        report_dict = report.as_dict()
        metrics = report_dict.get("metrics", [])
        dataset_result = metrics[0].get("result", {}) if metrics else {}
        columns_drift = {
            m["result"]["column_name"]: {
                "drift_score": m["result"].get("drift_score"),
                "drift_detected": m["result"].get("drift_detected", False),
                "stattest_name": m["result"].get("stattest_name"),
            }
            for m in metrics[1:]
        }
        results["evidently_drift"] = {
            "dataset_drift": dataset_result.get("dataset_drift", False),
            "share_of_drifted_columns": dataset_result.get(
                "share_of_drifted_columns", 0
            ),
            "number_of_drifted_columns": dataset_result.get(
                "number_of_drifted_columns", 0
            ),
            "columns": columns_drift,
        }
    except Exception as e:
        logger.warning("Evidently report failed: %s", e)
        results["evidently_drift"] = {"error": str(e)}

    return results


def load_reference_data(firestore_db) -> Optional[pd.DataFrame]:
    """Load reference (training) score distribution from Firestore."""
    try:
        doc = (
            firestore_db.collection("ml_reference_data")
            .document("underwriting_v1")
            .get()
        )
        if doc.exists:
            data = doc.to_dict()
            return pd.DataFrame(data.get("records", []))
    except Exception as e:
        logger.warning("Failed to load reference data: %s", e)
    return None


def load_current_data(firestore_db, days: int = 7) -> Optional[pd.DataFrame]:
    """Load recent scoring decisions from Firestore for drift comparison."""
    try:
        from datetime import timedelta

        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        docs = (
            firestore_db.collection("underwriting_decisions")
            .where("createdAt", ">=", cutoff.isoformat())
            .order_by("createdAt")
            .limit(5000)
            .stream()
        )
        records = []
        for doc in docs:
            d = doc.to_dict()
            features = d.get("features", {})
            row = {col: features.get(col, 0.0) for col in FEATURE_COLUMNS}
            row[SCORE_COLUMN] = d.get("score", 0.0)
            records.append(row)
        if records:
            return pd.DataFrame(records)
    except Exception as e:
        logger.warning("Failed to load current data: %s", e)
    return None


async def run_weekly_drift_job(firestore_db, alert_callback=None):
    """
    Entry point for the weekly scheduled drift check.
    Loads reference + current data, runs PSI/CSI, stores results, triggers alerts.
    """
    logger.info("Starting weekly drift check")

    reference_df = load_reference_data(firestore_db)
    if reference_df is None or len(reference_df) < 30:
        logger.info(
            "Skipping drift check — insufficient reference data (%s rows)",
            len(reference_df) if reference_df is not None else 0,
        )
        return {"skipped": True, "reason": "insufficient_reference_data"}

    current_df = load_current_data(firestore_db, days=7)
    if current_df is None or len(current_df) < 10:
        logger.info(
            "Skipping drift check — insufficient current data (%s rows)",
            len(current_df) if current_df is not None else 0,
        )
        return {"skipped": True, "reason": "insufficient_current_data"}

    results = run_drift_check(reference_df, current_df)

    # Store results in Firestore
    try:
        firestore_db.collection("ml_drift_reports").add(
            {
                **results,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        )
    except Exception as e:
        logger.warning("Failed to store drift report: %s", e)

    # Trigger alerts if any
    if results["alerts"] and alert_callback:
        for alert in results["alerts"]:
            try:
                await alert_callback(alert)
            except Exception as e:
                logger.warning("Alert callback failed: %s", e)

    logger.info(
        "Drift check complete: PSI=%s, alerts=%d",
        results.get("psi", {}),
        len(results.get("alerts", [])),
    )
    return results
