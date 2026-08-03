"""
Active learning for Stage 5 human-review routing using modAL.

When the model is uncertain about a loan decision, it routes the
application to human review rather than auto-deciding. This module
uses modAL's ActiveLearner with uncertainty sampling to identify
which borderline cases would benefit most from human review.

Flow:
  1. Score loan with champion/challenger models
  2. If uncertainty is high (close to decision threshold), route to human
  3. Human decisions are fed back to improve the model
"""

import logging

import joblib
import numpy as np
from modAL.models import ActiveLearner
from modAL.uncertainty import uncertainty_sampling, classifier_uncertainty
from sklearn.linear_model import LogisticRegression

logger = logging.getLogger("ml-service.active_learner")

# Loans with uncertainty above this threshold get routed to human review
DEFAULT_UNCERTAINTY_THRESHOLD = 0.35


class HumanReviewRouter:
    """
    Active learning-based router for Stage 5 human review.

    Uses modAL to track model uncertainty and route borderline
    loans to human underwriters for manual review.
    """

    def __init__(
        self,
        learner: ActiveLearner,
        uncertainty_threshold: float = DEFAULT_UNCERTAINTY_THRESHOLD,
    ):
        self.learner = learner
        self.uncertainty_threshold = uncertainty_threshold
        self.version = "active_learner_v1.0"

    def should_route_to_human(self, features: np.ndarray) -> dict:
        """
        Determine whether a loan should be routed to human review.

        Args:
            features: Feature vector (1, n_features) or (n_features,).

        Returns:
            {
                "route_to_human": bool,
                "uncertainty": float,
                "threshold": float,
                "predicted_class": int,
                "predicted_proba": float,
            }
        """
        x = features.reshape(1, -1) if features.ndim == 1 else features

        uncertainty = float(classifier_uncertainty(self.learner, x)[0])
        proba = self.learner.predict_proba(x)[0]
        predicted_class = int(np.argmax(proba))
        predicted_proba = float(proba[predicted_class])

        route = uncertainty > self.uncertainty_threshold

        if route:
            logger.info(
                "Routing to human review: uncertainty=%.4f (threshold=%.4f)",
                uncertainty,
                self.uncertainty_threshold,
            )

        return {
            "route_to_human": route,
            "uncertainty": round(uncertainty, 4),
            "threshold": self.uncertainty_threshold,
            "predicted_class": predicted_class,
            "predicted_proba": round(predicted_proba, 4),
        }

    def query_most_uncertain(self, X_pool: np.ndarray, n_instances: int = 5) -> tuple:
        """
        Select the most uncertain samples from a pool for human review.

        Args:
            X_pool: Feature matrix of pending loans.
            n_instances: Number of samples to select.

        Returns:
            Tuple of (indices, selected_X).
        """
        query_idx, query_instances = self.learner.query(X_pool, n_instances=n_instances)
        return query_idx, query_instances

    def teach(self, X: np.ndarray, y: np.ndarray):
        """
        Incorporate human-reviewed decisions into the model.

        Args:
            X: Feature matrix of reviewed loans.
            y: Human-assigned labels (1=approve, 0=reject).
        """
        self.learner.teach(X, y)
        logger.info("Active learner updated with %d human-reviewed samples", len(y))

    def save(self, path: str):
        joblib.dump(self, path)

    @classmethod
    def load(cls, path: str) -> "HumanReviewRouter":
        return joblib.load(path)

    @classmethod
    def create(
        cls,
        X_initial: np.ndarray,
        y_initial: np.ndarray,
        uncertainty_threshold: float = DEFAULT_UNCERTAINTY_THRESHOLD,
    ) -> "HumanReviewRouter":
        """
        Create a new active learner from initial labeled data.

        Args:
            X_initial: Initial labeled feature matrix.
            y_initial: Initial labels (1=repaid, 0=defaulted).
            uncertainty_threshold: Threshold for routing to human review.
        """
        estimator = LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            solver="lbfgs",
        )

        learner = ActiveLearner(
            estimator=estimator,
            query_strategy=uncertainty_sampling,
            X_training=X_initial,
            y_training=y_initial,
        )

        logger.info(
            "Created active learner with %d initial samples (threshold=%.2f)",
            len(y_initial),
            uncertainty_threshold,
        )
        return cls(learner=learner, uncertainty_threshold=uncertainty_threshold)
