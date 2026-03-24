"""
Stage 0 fraud pre-screen using Isolation Forest.

Runs before the main underwriting models to flag obviously fraudulent
applications based on velocity, device, and identity signals.

Isolation Forest detects anomalies as observations that require fewer
random splits to isolate, making it efficient for high-throughput
pre-screening.
"""

import logging
import os

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest

logger = logging.getLogger("ml-service.isolation_forest")

FEATURE_NAMES = [
    "requests_last_hour",
    "amount_to_salary_ratio",
    "device_age_days",
    "ip_reputation_score",
    "session_duration_seconds",
    "interaction_anomaly_score",
    "bureau_inquiries_last_30d",
    "distinct_ips_last_24h",
]

DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "isolation_forest_v1.joblib"
)


class FraudPreScreen:
    """
    Stage 0 Isolation Forest pre-screen.

    Flags applications as potentially fraudulent based on velocity,
    device, and identity signals before running expensive ML models.
    """

    def __init__(self, model: IsolationForest, feature_names: list[str], threshold: float = -0.10):
        self.model = model
        self.feature_names = feature_names
        self.threshold = threshold
        self.version = "isolation_forest_v1.0"

    def _build_vector(self, features: dict) -> np.ndarray:
        return np.array(
            [features.get(f, 0.0) for f in self.feature_names], dtype=np.float64
        )

    def predict(self, features: dict) -> dict:
        """
        Score a single application for Stage 0 fraud.

        Returns:
            {
                "anomaly_score": float (-1 = anomalous, +1 = normal),
                "is_fraud": bool,
                "threshold": float,
            }
        """
        x = self._build_vector(features).reshape(1, -1)
        score = float(self.model.decision_function(x)[0])
        is_fraud = score < self.threshold

        return {
            "anomaly_score": round(score, 6),
            "is_fraud": is_fraud,
            "threshold": self.threshold,
        }

    def predict_batch(self, feature_dicts: list[dict]) -> list[dict]:
        """Score multiple applications at once."""
        X = np.array([self._build_vector(f) for f in feature_dicts])
        scores = self.model.decision_function(X)
        return [
            {
                "anomaly_score": round(float(s), 6),
                "is_fraud": float(s) < self.threshold,
                "threshold": self.threshold,
            }
            for s in scores
        ]

    def save(self, path: str = DEFAULT_MODEL_PATH):
        joblib.dump(self, path)

    @classmethod
    def load(cls, path: str = DEFAULT_MODEL_PATH) -> "FraudPreScreen":
        return joblib.load(path)

    @classmethod
    def train(
        cls,
        X: np.ndarray,
        contamination: float = 0.05,
        n_estimators: int = 200,
        random_state: int = 42,
    ) -> "FraudPreScreen":
        """
        Train an Isolation Forest on legitimate application data.

        Args:
            X: Feature matrix (n_samples, n_features).
            contamination: Expected fraction of anomalies in training set.
            n_estimators: Number of isolation trees.
            random_state: For reproducibility.

        Returns:
            Trained FraudPreScreen instance.
        """
        model = IsolationForest(
            n_estimators=n_estimators,
            contamination=contamination,
            random_state=random_state,
            n_jobs=-1,
        )
        model.fit(X)

        # Calibrate threshold on training data
        scores = model.decision_function(X)
        threshold = float(np.percentile(scores, contamination * 100))

        logger.info(
            "Trained IsolationForest: n_estimators=%d, contamination=%.2f, threshold=%.4f",
            n_estimators, contamination, threshold,
        )
        return cls(model=model, feature_names=FEATURE_NAMES, threshold=threshold)
