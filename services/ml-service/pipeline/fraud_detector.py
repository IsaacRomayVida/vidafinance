"""Isolation Forest fraud detector — 8-feature behavioural anomaly detection.

The detector is trained once at import time on synthetic "normal" transaction
data so every scoring call is a pure in-memory inference with negligible
latency.  Hard-flag rules are applied before the model to handle obviously
fraudulent patterns (velocity attacks, impossible ratios, etc.).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
from sklearn.ensemble import IsolationForest

# ---------------------------------------------------------------------------
# Feature definitions (ordered — must match training column order)
# ---------------------------------------------------------------------------

FEATURE_NAMES = [
    "requests_last_hour",       # velocity: application count in last hour
    "amount_to_salary_ratio",   # requested amount / monthly salary
    "device_age_days",          # days since device registration
    "geo_distance_km",          # km from applicant's registered address
    "same_ip_applications",     # other loan apps from same IP (last 24h)
    "time_since_last_app_hours",# hours elapsed since previous application
    "kyc_confidence_score",     # KYC identity match confidence 0–100
    "bureau_inquiry_count",     # credit bureau hard-pull count (last 90d)
]

# Hard-flag thresholds — these fire before the IF model
_HARD_FLAGS = {
    "requests_last_hour": (">", 5, "High application velocity (>5/hr)"),
    "amount_to_salary_ratio": (">", 0.60, "Amount exceeds 60% of monthly salary"),
    "same_ip_applications": (">", 10, "More than 10 apps from same IP address"),
    "device_age_days": ("<", 1, "Device registered less than 24 hours ago"),
}

# Feature contribution: names used in explanation output
_ANOMALY_LABELS = {
    "requests_last_hour": "high_velocity",
    "amount_to_salary_ratio": "amount_salary_mismatch",
    "device_age_days": "new_device",
    "geo_distance_km": "unusual_location",
    "same_ip_applications": "ip_concentration",
    "time_since_last_app_hours": "rapid_reapplication",
    "kyc_confidence_score": "low_kyc_confidence",
    "bureau_inquiry_count": "high_inquiry_count",
}

# Fraud flag thresholds: above these value pairs, the feature is "anomalous"
_CONTRIBUTION_THRESHOLDS = {
    "requests_last_hour": 3,
    "amount_to_salary_ratio": 0.35,
    "device_age_days": 7,        # below this → anomalous (inverted)
    "geo_distance_km": 100,
    "same_ip_applications": 3,
    "time_since_last_app_hours": 1,  # below → anomalous (rapid reapplication)
    "kyc_confidence_score": 70,      # below → anomalous
    "bureau_inquiry_count": 8,
}

# Anomaly score thresholds
FRAUD_FLAG_THRESHOLD = 80    # hard reject
FRAUD_REVIEW_THRESHOLD = 50  # escalate to Stage 5 review


@dataclass
class FraudResult:
    fraud_score: float              # 0–100; higher = more suspicious
    is_fraud: bool                  # True when fraud_score >= FRAUD_FLAG_THRESHOLD
    needs_review: bool              # True when fraud_score >= FRAUD_REVIEW_THRESHOLD
    hard_flags: List[str]           # Triggered hard-flag rule descriptions
    anomaly_contributions: Dict[str, float]  # Per-feature anomaly signal
    isolation_forest_score: float   # Raw IF anomaly score (−1..0; lower = more anomalous)


# ---------------------------------------------------------------------------
# Model initialisation (runs once at import time)
# ---------------------------------------------------------------------------

def _generate_normal_data(n: int = 2000, seed: int = 42) -> np.ndarray:
    """Synthetic normal transaction data for training."""
    rng = np.random.default_rng(seed)
    return np.column_stack([
        rng.integers(0, 3, n).astype(float),           # requests_last_hour  0–2
        rng.uniform(0.03, 0.28, n),                     # amount_to_salary_ratio
        rng.uniform(30, 730, n),                        # device_age_days
        rng.uniform(0, 40, n),                          # geo_distance_km
        rng.integers(0, 3, n).astype(float),            # same_ip_applications 0–2
        rng.uniform(24, 720, n),                        # time_since_last_app_hours
        rng.uniform(75, 100, n),                        # kyc_confidence_score
        rng.integers(0, 6, n).astype(float),            # bureau_inquiry_count 0–5
    ])


_TRAIN_DATA = _generate_normal_data()
_MODEL = IsolationForest(
    n_estimators=200,
    contamination=0.08,
    random_state=42,
    n_jobs=-1 if os.cpu_count() and os.cpu_count() > 1 else 1,  # type: ignore[operator]
)
_MODEL.fit(_TRAIN_DATA)

# Calibrate positive ceiling from training distribution
# decision_function: positive = normal/in-distribution; negative = anomalous
_TRAIN_D_SCORES = _MODEL.decision_function(_TRAIN_DATA)
_D_POS_MAX = float(np.percentile(_TRAIN_D_SCORES, 95))  # ceiling for "very clean"

# Fixed absolute scale for the anomalous (negative) side, calibrated against
# empirically observed scores for truly fraudulent feature vectors.
# Inputs at d=0 get fraud_score≈25; at d=−0.10 they get ≈100.
_D_NEG_SCALE = 0.10


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_fraud_detection(signals: dict) -> FraudResult:
    """Evaluate fraud signals for a loan application.

    Args:
        signals: dict with keys matching FEATURE_NAMES (missing values → 0 / safe defaults).

    Returns:
        FraudResult with fraud_score in [0, 100] and feature contributions.
    """
    # ── 1. Extract feature vector ──────────────────────────────────────────
    values = {
        "requests_last_hour": float(signals.get("requests_last_hour", 0)),
        "amount_to_salary_ratio": float(signals.get("amount_to_salary_ratio", 0.10)),
        "device_age_days": float(signals.get("device_age_days", 365)),
        "geo_distance_km": float(signals.get("geo_distance_km", 0)),
        "same_ip_applications": float(signals.get("same_ip_applications", 0)),
        "time_since_last_app_hours": float(signals.get("time_since_last_app_hours", 720)),
        "kyc_confidence_score": float(signals.get("kyc_confidence_score", 90)),
        "bureau_inquiry_count": float(signals.get("bureau_inquiry_count", 0)),
    }

    # ── 2. Hard-flag rules ─────────────────────────────────────────────────
    hard_flags: List[str] = []
    for feat, (op, threshold, msg) in _HARD_FLAGS.items():
        v = values[feat]
        if (op == ">" and v > threshold) or (op == "<" and v < threshold):
            hard_flags.append(msg)

    if hard_flags:
        # Any hard flag → maximum fraud score
        contribs = _compute_contributions(values)
        return FraudResult(
            fraud_score=100.0,
            is_fraud=True,
            needs_review=True,
            hard_flags=hard_flags,
            anomaly_contributions=contribs,
            isolation_forest_score=-1.0,
        )

    # ── 3. Isolation Forest scoring ────────────────────────────────────────
    X = np.array([[values[f] for f in FEATURE_NAMES]])
    if_score = float(_MODEL.score_samples(X)[0])
    d_score = float(_MODEL.decision_function(X)[0])

    # Piecewise linear normalisation:
    #   d ≥ 0 (normal)    → fraud_score 0–25  (the higher d, the cleaner)
    #   d < 0 (anomalous) → fraud_score 25–100 (the lower d, the worse)
    # _D_NEG_SCALE = 0.10 means d=−0.10 maps to fraud_score=100.
    pos_max = max(_D_POS_MAX, 1e-6)
    if d_score >= 0:
        fraud_score = round(max(0.0, 25.0 - (d_score / pos_max) * 25.0), 1)
    else:
        fraud_score = round(min(100.0, 25.0 + (abs(d_score) / _D_NEG_SCALE) * 75.0), 1)

    contribs = _compute_contributions(values)

    return FraudResult(
        fraud_score=fraud_score,
        is_fraud=fraud_score >= FRAUD_FLAG_THRESHOLD,
        needs_review=fraud_score >= FRAUD_REVIEW_THRESHOLD,
        hard_flags=[],
        anomaly_contributions=contribs,
        isolation_forest_score=round(d_score, 4),
    )


def _compute_contributions(values: dict) -> Dict[str, float]:
    """Return per-feature anomaly contribution signals (0 = normal, 1 = anomalous)."""
    contribs: Dict[str, float] = {}
    for feat, label in _ANOMALY_LABELS.items():
        v = values.get(feat, 0.0)
        thresh = _CONTRIBUTION_THRESHOLDS[feat]
        if feat in ("device_age_days", "time_since_last_app_hours", "kyc_confidence_score"):
            # Lower is worse for these features
            signal = max(0.0, min(1.0, 1.0 - v / thresh)) if thresh > 0 else 0.0
        else:
            signal = max(0.0, min(1.0, v / thresh)) if thresh > 0 else 0.0
        contribs[label] = round(signal, 3)
    return contribs
