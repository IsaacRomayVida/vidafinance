"""Dagster-backed, offline champion/challenger experiment.

The pipeline is deliberately bounded and deterministic.  It produces evidence
and candidate artifacts; it never changes the live underwriting decision path.
Dagster is optional at import time so unit tests and the service image do not
need the orchestration runtime installed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

SEED = 20260816
FEATURES = ("credit_score", "monthly_salary", "tenure_months", "loan_to_income")
TARGET = "repaid"
REQUIRED_AUC = 0.60
MAX_PSI = 0.25


def reference_data(rows: int = 800, seed: int = SEED) -> pd.DataFrame:
    """Return deterministic, synthetic reference outcomes for experiments only."""
    if not isinstance(rows, int) or rows < 100 or rows > 10_000:
        raise ValueError("rows must be an integer between 100 and 10000")
    rng = np.random.default_rng(seed)
    credit = rng.normal(620, 85, rows).clip(300, 850)
    salary = rng.lognormal(np.log(14_000), 0.45, rows).clip(7_000, 60_000)
    tenure = rng.gamma(2.5, 18, rows).clip(0, 180)
    lti = (rng.uniform(500, 8_000, rows) / salary).clip(0.02, 1.2)
    logit = -1.8 + credit / 260 + tenure / 90 - lti * 2.2 + np.log(salary) / 8
    probability = 1 / (1 + np.exp(-logit))
    return pd.DataFrame(
        {
            "credit_score": credit,
            "monthly_salary": salary,
            "tenure_months": tenure,
            "loan_to_income": lti,
            TARGET: (rng.random(rows) < probability).astype(np.int8),
        }
    )


def prepare_features(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Validate and prepare a frame at the experiment boundary."""
    required = set(FEATURES) | {TARGET}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"missing required columns: {', '.join(missing)}")
    result = frame.loc[:, [*FEATURES, TARGET]].copy()
    if result.isna().any().any() or not np.isfinite(result.to_numpy(dtype=float)).all():
        raise ValueError("features and target must contain only finite values")
    if not result[TARGET].isin([0, 1]).all():
        raise ValueError("target must contain only 0 or 1")
    return result.loc[:, FEATURES], result[TARGET].astype(np.int8)


def train_models(X: pd.DataFrame, y: pd.Series) -> dict[str, Any]:
    """Train independent champion and challenger models with fixed seeds."""
    champion = Pipeline(
        [
            ("scale", StandardScaler()),
            ("model", LogisticRegression(random_state=SEED, max_iter=500)),
        ]
    )
    challenger = HistGradientBoostingClassifier(
        max_iter=80, max_leaf_nodes=12, learning_rate=0.08, random_state=SEED
    )
    champion.fit(X, y)
    challenger.fit(X, y)
    return {"champion": champion, "challenger": challenger}


def evaluate_models(
    models: dict[str, Any], X: pd.DataFrame, y: pd.Series
) -> dict[str, Any]:
    """Return auditable holdout metrics for both models."""
    metrics: dict[str, Any] = {}
    for name, model in models.items():
        probabilities = model.predict_proba(X)[:, 1]
        metrics[name] = {
            "auc": round(float(roc_auc_score(y, probabilities)), 6),
            "brier": round(float(brier_score_loss(y, probabilities)), 6),
            "accuracy": round(float(accuracy_score(y, probabilities >= 0.5)), 6),
            "rows": int(len(y)),
        }
    return metrics


def population_stability_index(
    reference: pd.Series, current: pd.Series, bins: int = 10
) -> float:
    """Compute PSI using reference quantile cut points; never silently drops bins."""
    if len(reference) == 0 or len(current) == 0:
        raise ValueError("PSI requires non-empty populations")
    edges = np.unique(np.quantile(reference, np.linspace(0, 1, bins + 1)))
    if len(edges) < 2:
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    expected = np.histogram(reference, edges)[0] / len(reference)
    actual = np.histogram(current, edges)[0] / len(current)
    expected = np.clip(expected, 1e-6, None)
    actual = np.clip(actual, 1e-6, None)
    return float(np.sum((actual - expected) * np.log(actual / expected)))


def drift_report(reference: pd.DataFrame, current: pd.DataFrame) -> dict[str, Any]:
    """Report feature PSI and fail closed on missing feature columns."""
    missing = sorted(set(FEATURES) - set(current.columns))
    if missing:
        raise ValueError(f"missing current features: {', '.join(missing)}")
    psi = {
        feature: round(
            population_stability_index(reference[feature], current[feature]), 6
        )
        for feature in FEATURES
    }
    return {
        "features": psi,
        "max_psi": max(psi.values(), default=0.0),
        "threshold": MAX_PSI,
        "status": "alert" if max(psi.values(), default=0.0) > MAX_PSI else "ok",
    }


def approval_gate(metrics: dict[str, Any], drift: dict[str, Any]) -> dict[str, Any]:
    """Approve only a strong champion and a clean drift report."""
    champion_auc = metrics["champion"]["auc"]
    approved = champion_auc >= REQUIRED_AUC and drift["max_psi"] <= MAX_PSI
    return {
        "approved": bool(approved),
        "reasons": (
            []
            if approved
            else [
                *(
                    []
                    if champion_auc >= REQUIRED_AUC
                    else ["champion_auc_below_threshold"]
                ),
                *(
                    []
                    if drift["max_psi"] <= MAX_PSI
                    else ["feature_drift_above_threshold"]
                ),
            ]
        ),
        "required_auc": REQUIRED_AUC,
        "max_psi": MAX_PSI,
    }


def export_artifacts(
    models: dict[str, Any],
    metrics: dict[str, Any],
    drift: dict[str, Any],
    gate: dict[str, Any],
    output_dir: str | Path,
) -> dict[str, Any]:
    """Write candidate artifacts atomically enough for local/offline use."""
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": 1,
        "authority": "shadow_only",
        "metrics": metrics,
        "drift": drift,
        "gate": gate,
    }
    for name, model in models.items():
        joblib.dump(model, destination / f"{name}.joblib")
    manifest["artifact_sha256"] = {
        name: hashlib.sha256((destination / f"{name}.joblib").read_bytes()).hexdigest()
        for name in models
    }
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def run_experiment(
    output_dir: str | Path, rows: int = 800, seed: int = SEED
) -> dict[str, Any]:
    """Execute the bounded pipeline end to end."""
    frame = reference_data(rows, seed)
    X, y = prepare_features(frame)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=seed, stratify=y
    )
    models = train_models(X_train, y_train)
    metrics = evaluate_models(models, X_test, y_test)
    drift = drift_report(X_train, X_test)
    gate = approval_gate(metrics, drift)
    return export_artifacts(models, metrics, drift, gate, output_dir)


try:  # Optional dependency: the pure functions remain usable without Dagster.
    from dagster import Definitions, op, job

    @op
    def run_ml_experiment_op() -> dict[str, Any]:
        return run_experiment("artifacts/ml-experiment")

    @job
    def ml_experiment_job() -> None:
        run_ml_experiment_op()

    defs = Definitions(jobs=[ml_experiment_job])
except ImportError:  # pragma: no cover - exercised in the lean service image
    ml_experiment_job = None
    defs = None
