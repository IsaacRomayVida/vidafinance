"""
Champion/Challenger routing for underwriting models.

Runs BOTH the WoE scorecard champion and XGBoost challenger on every
prediction. The champion's decision is authoritative. The challenger's
prediction is logged for shadow comparison.

A rolling 30-day Gini comparison triggers an alert when the challenger
outperforms the champion by >= 0.02.
"""

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from models.scorecard_model import ScorecardChampion
from models.xgb_model import XGBChallenger

logger = logging.getLogger("champion_challenger")

CHALLENGER_GINI_THRESHOLD = 0.02  # alert if challenger beats champion by this
ROLLING_WINDOW_SECONDS = 30 * 24 * 3600  # 30 days


@dataclass
class PredictionRecord:
    timestamp: float
    champion_score: float
    challenger_score: float
    actual_outcome: Optional[float] = None  # filled later when loan resolves


@dataclass
class ModelRouter:
    """
    Routes predictions through champion and challenger models.

    The champion (WoE scorecard) makes the decision.
    The challenger (XGBoost) runs in shadow mode for comparison.
    """

    champion: ScorecardChampion
    challenger: XGBChallenger
    history: deque = field(default_factory=lambda: deque(maxlen=10000))

    def predict(self, features: dict, threshold: float = 0.65) -> dict:
        """
        Run both models and return the champion's decision.

        Returns dict with:
          - decision: "approved" | "rejected"
          - champion_score: float
          - challenger_score: float
          - champion_model: str
          - challenger_model: str
          - shap_top5: list[dict]  (from challenger)
        """
        champion_score = self.champion.predict_proba(features)
        challenger_score = self.challenger.predict_proba(features)

        decision = "approved" if champion_score >= threshold else "rejected"

        # SHAP explanations from challenger
        try:
            shap_top5 = self.challenger.explain(features, top_n=5)
        except Exception as e:
            logger.warning("SHAP explanation failed: %s", e)
            shap_top5 = []

        # Record for rolling comparison
        self.history.append(PredictionRecord(
            timestamp=time.time(),
            champion_score=champion_score,
            challenger_score=challenger_score,
        ))

        return {
            "decision": decision,
            "champion_score": round(champion_score, 4),
            "challenger_score": round(challenger_score, 4),
            "champion_model": self.champion.version,
            "challenger_model": self.challenger.version,
            "shap_top5": shap_top5,
        }

    def record_outcome(self, champion_score: float, challenger_score: float, actual: float):
        """Record a resolved loan outcome for Gini tracking."""
        for record in reversed(self.history):
            if (
                abs(record.champion_score - champion_score) < 1e-6
                and abs(record.challenger_score - challenger_score) < 1e-6
                and record.actual_outcome is None
            ):
                record.actual_outcome = actual
                break

    def check_challenger_alert(self) -> Optional[dict]:
        """
        Compare rolling 30-day Gini between champion and challenger.

        Returns alert dict if challenger outperforms by >= CHALLENGER_GINI_THRESHOLD,
        otherwise None.
        """
        cutoff = time.time() - ROLLING_WINDOW_SECONDS
        resolved = [
            r for r in self.history
            if r.actual_outcome is not None and r.timestamp >= cutoff
        ]

        if len(resolved) < 50:
            return None  # not enough data

        actuals = np.array([r.actual_outcome for r in resolved])
        champion_scores = np.array([r.champion_score for r in resolved])
        challenger_scores = np.array([r.challenger_score for r in resolved])

        champion_gini = self._gini_coefficient(actuals, champion_scores)
        challenger_gini = self._gini_coefficient(actuals, challenger_scores)

        if challenger_gini - champion_gini >= CHALLENGER_GINI_THRESHOLD:
            alert = {
                "type": "challenger_outperforms",
                "champion_gini": round(champion_gini, 4),
                "challenger_gini": round(challenger_gini, 4),
                "delta": round(challenger_gini - champion_gini, 4),
                "sample_size": len(resolved),
                "window_days": 30,
            }
            logger.warning(
                "ALERT: Challenger outperforms champion — Gini delta=%.4f (n=%d)",
                alert["delta"],
                len(resolved),
            )
            return alert

        return None

    @staticmethod
    def _gini_coefficient(actuals: np.ndarray, predictions: np.ndarray) -> float:
        """Compute normalized Gini coefficient (2*AUC - 1)."""
        n = len(actuals)
        if n == 0 or actuals.std() == 0:
            return 0.0

        # Sort by predicted score descending
        order = np.argsort(-predictions)
        sorted_actuals = actuals[order]

        # Gini = 2*AUC - 1, computed via trapezoidal sum
        cumulative = np.cumsum(sorted_actuals)
        gini = (2.0 * cumulative.sum() / cumulative[-1] - (n + 1)) / n
        return float(gini)

    @classmethod
    def load(cls, champion_path: str, challenger_path: str) -> "ModelRouter":
        champion = ScorecardChampion.load(champion_path)
        challenger = XGBChallenger.load(challenger_path)
        return cls(champion=champion, challenger=challenger)
