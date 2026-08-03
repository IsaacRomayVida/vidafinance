"""
Train the Stage 0 Isolation Forest fraud pre-screen model.

Generates synthetic legitimate + fraudulent application data,
trains an Isolation Forest on the legitimate set, calibrates
the threshold on the combined set, and saves the model.

Usage:
    cd services/ml-service
    python scripts/train_isolation_forest.py
"""

import os
import sys
import logging

import numpy as np
from sklearn.metrics import precision_score, recall_score, f1_score

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from models.isolation_forest import FraudPreScreen, FEATURE_NAMES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("train_isolation_forest")


def generate_legitimate_data(n: int = 5000, seed: int = 42) -> np.ndarray:
    """Generate synthetic legitimate application data."""
    rng = np.random.RandomState(seed)
    return np.column_stack(
        [
            rng.poisson(0.5, n).astype(float),  # requests_last_hour (low)
            rng.uniform(0.05, 0.30, n),  # amount_to_salary_ratio (reasonable)
            rng.uniform(30, 3650, n),  # device_age_days (old devices)
            rng.uniform(60, 100, n),  # ip_reputation_score (good)
            rng.uniform(60, 1200, n),  # session_duration_seconds (normal)
            rng.uniform(0, 20, n),  # interaction_anomaly_score (low)
            rng.poisson(1.5, n).astype(float),  # bureau_inquiries_last_30d (few)
            rng.choice([1, 2], n, p=[0.85, 0.15]).astype(
                float
            ),  # distinct_ips_last_24h (1-2)
        ]
    )


def generate_fraud_data(n: int = 300, seed: int = 99) -> np.ndarray:
    """Generate synthetic fraudulent application data."""
    rng = np.random.RandomState(seed)
    return np.column_stack(
        [
            rng.poisson(8, n).astype(float),  # requests_last_hour (high velocity)
            rng.uniform(0.35, 0.95, n),  # amount_to_salary_ratio (excessive)
            rng.uniform(0, 15, n),  # device_age_days (new/disposable)
            rng.uniform(0, 35, n),  # ip_reputation_score (bad)
            rng.uniform(5, 45, n),  # session_duration_seconds (very fast)
            rng.uniform(55, 100, n),  # interaction_anomaly_score (high)
            rng.poisson(8, n).astype(float),  # bureau_inquiries_last_30d (many)
            rng.choice([3, 4, 5, 6], n).astype(float),  # distinct_ips_last_24h (many)
        ]
    )


def main():
    logger.info("=== Training Stage 0 Isolation Forest ===")
    logger.info("Features: %s", FEATURE_NAMES)

    # Generate data
    X_legit = generate_legitimate_data(5000)
    X_fraud = generate_fraud_data(300)
    logger.info(
        "Generated %d legitimate + %d fraud samples", len(X_legit), len(X_fraud)
    )

    # Train on legitimate data only (unsupervised)
    model = FraudPreScreen.train(X_legit, contamination=0.05, n_estimators=200)

    # Evaluate on combined set
    X_all = np.vstack([X_legit, X_fraud])
    y_true = np.concatenate([np.zeros(len(X_legit)), np.ones(len(X_fraud))])

    predictions = model.predict_batch([dict(zip(FEATURE_NAMES, row)) for row in X_all])
    y_pred = np.array([1 if p["is_fraud"] else 0 for p in predictions])

    precision = precision_score(y_true, y_pred)
    recall = recall_score(y_true, y_pred)
    f1 = f1_score(y_true, y_pred)
    fraud_flagged = y_pred.sum()
    legit_flagged = y_pred[: len(X_legit)].sum()

    logger.info("--- Evaluation ---")
    logger.info("Precision: %.4f", precision)
    logger.info("Recall:    %.4f", recall)
    logger.info("F1 Score:  %.4f", f1)
    logger.info("Total flagged as fraud: %d / %d", fraud_flagged, len(X_all))
    logger.info("False positives (legit flagged): %d / %d", legit_flagged, len(X_legit))

    # Save model
    output_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "models",
        "isolation_forest_v1.joblib",
    )
    model.save(output_path)
    logger.info("Model saved to %s", output_path)


if __name__ == "__main__":
    main()
