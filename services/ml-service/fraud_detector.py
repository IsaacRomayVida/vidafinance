"""
fraud_detector.py
Isolation-Forest anomaly detector for VIDA Finance fraud screening.

Ships with a pre-configured Isolation Forest trained on synthetic
distributions calibrated to Mexico micro-lending fraud patterns.
Once 200+ real loans are collected, call fit() with labelled data.

Features consumed (all optional — missing → median imputation):
  - requests_last_hour        : int   (velocity signal)
  - amount_to_salary_ratio    : float (over-borrowing signal)
  - device_risk_score         : float (0-100 from FingerprintJS / Sardine)
  - behavioral_risk_score     : float (0-100 from Sardine behavioral)
  - hour_of_day               : int   (0-23, unusual-hour signal)
  - days_since_account_created: int   (new-account signal)
  - ip_country_mismatch       : bool  (0/1)
  - bureau_inquiries_90d      : int   (credit-shopping signal)
"""

from __future__ import annotations

import os
import pickle
from dataclasses import dataclass, field

import numpy as np
from sklearn.ensemble import IsolationForest

FEATURE_ORDER = [
    "requests_last_hour",
    "amount_to_salary_ratio",
    "device_risk_score",
    "behavioral_risk_score",
    "hour_of_day",
    "days_since_account_created",
    "ip_country_mismatch",
    "bureau_inquiries_90d",
]

# Medians used for imputation (expert-set, updated by fit())
_MEDIANS = {
    "requests_last_hour": 0,
    "amount_to_salary_ratio": 0.20,
    "device_risk_score": 15.0,
    "behavioral_risk_score": 15.0,
    "hour_of_day": 14,
    "days_since_account_created": 90,
    "ip_country_mismatch": 0,
    "bureau_inquiries_90d": 1,
}

# Thresholds for rule-based hard flags (bypass model)
_HARD_FLAG_RULES = {
    "requests_last_hour": lambda v: v > 5,
    "amount_to_salary_ratio": lambda v: v > 0.40,
    "device_risk_score": lambda v: v >= 80,
    "behavioral_risk_score": lambda v: v >= 80,
    "ip_country_mismatch": lambda v: v == 1,
}

MODEL_PATH = os.environ.get("FRAUD_MODEL_PATH", "/models/isolation_forest.pkl")

# Module-level model — lazy-loaded
_model: IsolationForest | None = None


def _get_model() -> IsolationForest:
    """Load persisted model or create a default one."""
    global _model
    if _model is not None:
        return _model

    if os.path.exists(MODEL_PATH):
        with open(MODEL_PATH, "rb") as f:
            _model = pickle.load(f)
        return _model

    # Default model trained on synthetic normal distribution
    rng = np.random.RandomState(42)
    n = 1000
    synthetic = np.column_stack([
        rng.poisson(0.5, n),            # requests_last_hour
        rng.beta(2, 8, n) * 0.35,       # amount_to_salary_ratio
        rng.beta(2, 10, n) * 50,        # device_risk_score
        rng.beta(2, 10, n) * 50,        # behavioral_risk_score
        rng.randint(8, 22, n),          # hour_of_day (business hours)
        rng.exponential(120, n),        # days_since_account_created
        rng.binomial(1, 0.02, n),       # ip_country_mismatch
        rng.poisson(1.5, n),            # bureau_inquiries_90d
    ])

    _model = IsolationForest(
        n_estimators=200,
        contamination=0.05,
        max_samples=min(256, n),
        random_state=42,
        n_jobs=-1,
    )
    _model.fit(synthetic)
    return _model


@dataclass
class FraudResult:
    anomaly_score: float        # 0-100 (higher = more anomalous)
    is_fraud: bool
    hard_flags: list[str] = field(default_factory=list)
    feature_contributions: dict[str, float] = field(default_factory=dict)
    model: str = "isolation_forest_v1"


def _raw_to_vector(payload: dict) -> np.ndarray:
    """Convert payload dict to feature vector with median imputation."""
    vec = []
    for feat in FEATURE_ORDER:
        val = payload.get(feat)
        if val is None:
            val = _MEDIANS[feat]
        vec.append(float(val))
    return np.array(vec).reshape(1, -1)


def detect(payload: dict) -> FraudResult:
    """Run fraud detection on a single application.

    Returns FraudResult with anomaly_score (0-100) and is_fraud flag.
    Hard-flag rules override the model for obvious fraud signals.
    """
    # Check hard-flag rules first
    hard_flags: list[str] = []
    for feat, rule in _HARD_FLAG_RULES.items():
        val = payload.get(feat)
        if val is not None and rule(val):
            hard_flags.append(feat)

    # Run Isolation Forest
    model = _get_model()
    X = _raw_to_vector(payload)
    raw_score = model.decision_function(X)[0]  # negative = more anomalous
    # Map to 0-100 scale: decision_function ~[-0.5, 0.5] for typical data
    anomaly_score = max(0, min(100, round(50 - raw_score * 100)))

    # Feature contributions via single-feature perturbation
    contributions: dict[str, float] = {}
    baseline = raw_score
    X_perturbed = X.copy()
    for i, feat in enumerate(FEATURE_ORDER):
        X_perturbed[0, i] = _MEDIANS[feat]
        perturbed_score = model.decision_function(X_perturbed)[0]
        contributions[feat] = round(float(baseline - perturbed_score) * 100, 2)
        X_perturbed[0, i] = X[0, i]  # restore

    # is_fraud if anomaly_score >= 65 OR any hard flags
    is_fraud = anomaly_score >= 65 or len(hard_flags) > 0

    return FraudResult(
        anomaly_score=round(anomaly_score, 1),
        is_fraud=is_fraud,
        hard_flags=hard_flags,
        feature_contributions=contributions,
    )


def fit(X: np.ndarray, y: np.ndarray | None = None) -> dict:
    """Re-train Isolation Forest on real transaction data.

    Parameters
    ----------
    X : ndarray of shape (n, 8) — feature matrix (FEATURE_ORDER)
    y : optional labels (1=fraud). If provided, used only for evaluation
        (Isolation Forest is unsupervised).

    Returns
    -------
    dict with 'n_samples', 'contamination', 'model_path', and optional metrics.
    """
    from sklearn.metrics import roc_auc_score

    global _model, _MEDIANS

    if X.shape[1] != len(FEATURE_ORDER):
        raise ValueError(f"Expected {len(FEATURE_ORDER)} features, got {X.shape[1]}")

    # Update medians from real data
    for i, feat in enumerate(FEATURE_ORDER):
        _MEDIANS[feat] = float(np.nanmedian(X[:, i]))

    # Estimate contamination from labels or default 5%
    contamination = 0.05
    if y is not None:
        fraud_rate = float(y.mean())
        contamination = max(0.01, min(0.20, fraud_rate))

    _model = IsolationForest(
        n_estimators=200,
        contamination=contamination,
        max_samples=min(256, len(X)),
        random_state=42,
        n_jobs=-1,
    )
    _model.fit(X)

    # Persist model
    os.makedirs(os.path.dirname(MODEL_PATH) or ".", exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(_model, f)

    result = {
        "n_samples": len(X),
        "contamination": round(contamination, 4),
        "model_path": MODEL_PATH,
    }

    if y is not None:
        scores = _model.decision_function(X)
        auc = roc_auc_score(y, -scores)  # negate: lower score = more anomalous
        result["auc"] = round(auc, 4)

    return result
