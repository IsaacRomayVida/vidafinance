"""
Pseudo-labeling via sklearn SelfTrainingClassifier.

Used to leverage unlabeled loan applications (those still in progress
or not yet resolved) to improve the training set. The SelfTraining
wrapper iteratively assigns pseudo-labels to high-confidence unlabeled
samples and retrains.

Flow:
  1. Start with labeled data (resolved loans: repaid=1, defaulted=0)
  2. Add unlabeled data (pending loans: label=-1)
  3. SelfTrainingClassifier iteratively labels high-confidence samples
  4. Returns an expanded labeled dataset for model retraining
"""

from __future__ import annotations

import logging
from typing import Optional

import joblib
import numpy as np
from sklearn.semi_supervised import SelfTrainingClassifier
from sklearn.linear_model import LogisticRegression

logger = logging.getLogger("ml-service.pseudo_labeler")


class PseudoLabeler:
    """
    Wraps sklearn SelfTrainingClassifier for semi-supervised learning.

    Uses logistic regression as the base estimator (must support
    predict_proba for confidence-based pseudo-labeling).
    """

    def __init__(self, model: Optional[SelfTrainingClassifier] = None):
        self.model = model
        self.version = "pseudo_labeler_v1.0"

    def fit(
        self,
        X_labeled: np.ndarray,
        y_labeled: np.ndarray,
        X_unlabeled: np.ndarray,
        threshold: float = 0.85,
        max_iter: int = 20,
    ) -> dict:
        """
        Train with pseudo-labeling on labeled + unlabeled data.

        Args:
            X_labeled: Feature matrix for resolved loans.
            y_labeled: Binary labels (1=repaid, 0=defaulted).
            X_unlabeled: Feature matrix for unresolved loans.
            threshold: Confidence threshold for pseudo-labeling.
            max_iter: Maximum self-training iterations.

        Returns:
            Training summary with pseudo-label statistics.
        """
        # Combine labeled and unlabeled data
        X_all = np.vstack([X_labeled, X_unlabeled])
        y_all = np.concatenate([
            y_labeled,
            np.full(X_unlabeled.shape[0], -1),  # -1 = unlabeled
        ])

        base_estimator = LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            solver="lbfgs",
        )

        self.model = SelfTrainingClassifier(
            estimator=base_estimator,
            threshold=threshold,
            max_iter=max_iter,
            verbose=False,
        )
        self.model.fit(X_all, y_all)

        # Compute statistics
        pseudo_labels = self.model.transduction_[len(y_labeled):]
        n_pseudo_labeled = int(np.sum(pseudo_labels >= 0))
        n_pseudo_positive = int(np.sum(pseudo_labels == 1))
        n_pseudo_negative = int(np.sum(pseudo_labels == 0))

        summary = {
            "n_labeled": len(y_labeled),
            "n_unlabeled": len(X_unlabeled),
            "n_pseudo_labeled": n_pseudo_labeled,
            "n_pseudo_positive": n_pseudo_positive,
            "n_pseudo_negative": n_pseudo_negative,
            "n_iterations": self.model.n_iter_,
            "pseudo_label_rate": round(n_pseudo_labeled / max(len(X_unlabeled), 1), 4),
        }

        logger.info(
            "Pseudo-labeling complete: %d/%d unlabeled samples assigned labels in %d iterations",
            n_pseudo_labeled, len(X_unlabeled), self.model.n_iter_,
        )
        return summary

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return P(repayment) for each sample."""
        if self.model is None:
            raise RuntimeError("Model not trained. Call fit() first.")
        return self.model.predict_proba(X)[:, 1]

    def get_expanded_labels(self, y_original: np.ndarray, n_unlabeled: int) -> np.ndarray:
        """
        Return the full label array after pseudo-labeling.

        Useful for extracting the expanded training set for downstream
        model retraining.
        """
        if self.model is None:
            raise RuntimeError("Model not trained. Call fit() first.")
        return self.model.transduction_

    def save(self, path: str):
        joblib.dump(self, path)

    @classmethod
    def load(cls, path: str) -> "PseudoLabeler":
        return joblib.load(path)
