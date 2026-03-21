"""
PSI (Population Stability Index) and CSI (Characteristic Stability Index)
calculator for monitoring model and feature drift.

PSI measures shift in the overall score distribution.
CSI measures shift in individual feature distributions.

Alert thresholds:
  PSI < 0.10  → No significant drift
  PSI 0.10–0.25 → Warning — moderate drift detected
  PSI > 0.25  → Retrain trigger — significant population shift
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from evidently.report import Report
from evidently.metric_preset import DataDriftPreset

logger = logging.getLogger("ml-service.drift")

BASELINE_PATH = os.environ.get(
    "BASELINE_PATH",
    os.path.join(os.path.dirname(__file__), "baselines", "v1_baseline.json"),
)

FEATURE_NAMES = [
    "employment_tenure_months",
    "monthly_salary",
    "pay_frequency_encoded",
    "loan_to_salary_ratio",
    "employer_industry_encoded",
    "principal_amount",
    "bureau_score",
    "has_bureau_record",
]

PSI_WARNING_THRESHOLD = 0.10
PSI_RETRAIN_THRESHOLD = 0.25
DEFAULT_BINS = 10


def compute_psi(expected: np.ndarray, actual: np.ndarray, bins: int = DEFAULT_BINS) -> float:
    """
    Compute Population Stability Index between two distributions.

    Uses equal-width binning based on the expected (baseline) distribution.
    A small epsilon is added to avoid log(0).
    """
    eps = 1e-4

    breakpoints = np.linspace(
        min(expected.min(), actual.min()) - eps,
        max(expected.max(), actual.max()) + eps,
        bins + 1,
    )

    expected_counts = np.histogram(expected, bins=breakpoints)[0].astype(float)
    actual_counts = np.histogram(actual, bins=breakpoints)[0].astype(float)

    expected_pct = expected_counts / expected_counts.sum()
    actual_pct = actual_counts / actual_counts.sum()

    # Avoid division by zero / log(0)
    expected_pct = np.clip(expected_pct, eps, None)
    actual_pct = np.clip(actual_pct, eps, None)

    psi = np.sum((actual_pct - expected_pct) * np.log(actual_pct / expected_pct))
    return float(psi)


def compute_csi(baseline: dict, current_values: np.ndarray, bins: int = DEFAULT_BINS) -> dict:
    """
    Compute Characteristic Stability Index for a single feature.

    Returns PSI value plus summary statistics for comparison.
    """
    # Reconstruct baseline distribution from stored histogram
    hist = baseline["histogram"]
    bin_edges = np.array(hist["bin_edges"])
    baseline_counts = np.array(hist["counts"], dtype=float)

    eps = 1e-4

    # Bin current values using baseline bin edges
    current_counts = np.histogram(current_values, bins=bin_edges)[0].astype(float)

    baseline_pct = baseline_counts / baseline_counts.sum()
    current_pct = current_counts / current_counts.sum()

    baseline_pct = np.clip(baseline_pct, eps, None)
    current_pct = np.clip(current_pct, eps, None)

    csi = float(np.sum((current_pct - baseline_pct) * np.log(current_pct / baseline_pct)))

    return {
        "csi": round(csi, 6),
        "baseline_mean": baseline["mean"],
        "current_mean": round(float(current_values.mean()), 4),
        "baseline_std": baseline["std"],
        "current_std": round(float(current_values.std()), 4),
    }


def classify_drift(psi: float) -> str:
    """Classify PSI value into drift severity level."""
    if psi > PSI_RETRAIN_THRESHOLD:
        return "retrain"
    if psi > PSI_WARNING_THRESHOLD:
        return "warning"
    return "stable"


def load_baseline(path: str | None = None) -> dict:
    """Load baseline distributions from JSON."""
    path = path or BASELINE_PATH
    with open(path) as f:
        return json.load(f)


def save_baseline(baseline: dict, path: str | None = None):
    """Save baseline distributions to JSON."""
    path = path or BASELINE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(baseline, f, indent=2)
    logger.info("Baseline saved to %s", path)


def generate_baseline_from_data(X: np.ndarray, scores: np.ndarray, bins: int = DEFAULT_BINS) -> dict:
    """
    Generate baseline distributions from training data.

    Args:
        X: Feature matrix (n_samples, n_features) — column order matches FEATURE_NAMES.
        scores: Model output scores (n_samples,).
        bins: Number of histogram bins.

    Returns:
        Baseline dict with feature stats, histograms, and score distribution.
    """
    percentile_keys = [10, 25, 50, 75, 90]
    features = {}

    for i, name in enumerate(FEATURE_NAMES):
        col = X[:, i]
        percentiles = {str(p): round(float(np.percentile(col, p)), 4) for p in percentile_keys}

        hist_counts, hist_edges = np.histogram(col, bins=bins)
        features[name] = {
            "mean": round(float(col.mean()), 4),
            "std": round(float(col.std()), 4),
            "min": round(float(col.min()), 4),
            "max": round(float(col.max()), 4),
            "percentiles": percentiles,
            "histogram": {
                "counts": hist_counts.tolist(),
                "bin_edges": [round(float(e), 6) for e in hist_edges],
            },
        }

    # Score distribution
    score_hist_counts, score_hist_edges = np.histogram(scores, bins=bins)
    score_dist = {
        "mean": round(float(scores.mean()), 4),
        "std": round(float(scores.std()), 4),
        "min": round(float(scores.min()), 4),
        "max": round(float(scores.max()), 4),
        "percentiles": {str(p): round(float(np.percentile(scores, p)), 4) for p in percentile_keys},
        "histogram": {
            "counts": score_hist_counts.tolist(),
            "bin_edges": [round(float(e), 6) for e in score_hist_edges],
        },
    }

    return {
        "model_version": "logistic_v1.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": int(X.shape[0]),
        "n_features": len(FEATURE_NAMES),
        "feature_names": FEATURE_NAMES,
        "features": features,
        "score_distribution": score_dist,
        "thresholds": {
            "psi_warning": PSI_WARNING_THRESHOLD,
            "psi_retrain": PSI_RETRAIN_THRESHOLD,
        },
    }


def run_drift_check(
    current_features: np.ndarray,
    current_scores: np.ndarray,
    baseline: dict | None = None,
) -> dict:
    """
    Run full PSI + per-feature CSI drift check against baseline.

    Args:
        current_features: Feature matrix (n_samples, n_features).
        current_scores: Model output scores (n_samples,).
        baseline: Baseline dict. Loaded from disk if not provided.

    Returns:
        Drift report dict with PSI, per-feature CSI, and alert level.
    """
    if baseline is None:
        baseline = load_baseline()

    # Overall score PSI
    baseline_scores = baseline["score_distribution"]
    score_hist = baseline_scores["histogram"]
    baseline_score_edges = np.array(score_hist["bin_edges"])
    baseline_score_counts = np.array(score_hist["counts"], dtype=float)

    eps = 1e-4
    current_score_counts = np.histogram(current_scores, bins=baseline_score_edges)[0].astype(float)
    baseline_pct = np.clip(baseline_score_counts / baseline_score_counts.sum(), eps, None)
    current_pct = np.clip(current_score_counts / current_score_counts.sum(), eps, None)
    score_psi = float(np.sum((current_pct - baseline_pct) * np.log(current_pct / baseline_pct)))

    # Per-feature CSI
    feature_csi = {}
    for i, name in enumerate(FEATURE_NAMES):
        feature_csi[name] = compute_csi(
            baseline["features"][name],
            current_features[:, i],
        )

    alert_level = classify_drift(score_psi)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model_version": baseline.get("model_version", "unknown"),
        "baseline_samples": baseline.get("n_samples", 0),
        "current_samples": int(current_features.shape[0]),
        "score_psi": round(score_psi, 6),
        "alert_level": alert_level,
        "feature_csi": feature_csi,
        "thresholds": {
            "psi_warning": PSI_WARNING_THRESHOLD,
            "psi_retrain": PSI_RETRAIN_THRESHOLD,
        },
    }


def run_evidently_drift_report(
    reference_df: pd.DataFrame,
    current_df: pd.DataFrame,
) -> dict:
    """
    Run evidently-ai DataDriftPreset for a comprehensive drift report.

    Args:
        reference_df: Baseline feature DataFrame.
        current_df: Current feature DataFrame.

    Returns:
        Evidently drift report as a dict.
    """
    report = Report(metrics=[DataDriftPreset()])
    report.run(reference_data=reference_df, current_data=current_df)
    return report.as_dict()
