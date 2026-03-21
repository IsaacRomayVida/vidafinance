"""
Champion/Challenger model router.

Runs both the WoE scorecard champion and XGBoost challenger on every
prediction. Uses the champion for the actual decision. Logs challenger
predictions for offline comparison. Alerts if challenger outperforms
champion by +0.02 Gini on a rolling 30-day window.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from models.scorecard_model import ScorecardModel
from models.xgb_model import XGBoostChallengerModel

logger = logging.getLogger("model_router")


@dataclass
class PredictionRecord:
    """Single prediction record for performance tracking."""
    timestamp: float
    champion_prob: float
    challenger_prob: float
    actual_label: Optional[float] = None  # Set later when outcome is known


class ChampionChallengerRouter:
    """
    Routes predictions through champion and challenger models.

    The champion model is used for the actual underwriting decision.
    The challenger runs in shadow mode — its predictions are logged
    but never used for decisions until promoted.
    """

    ROLLING_WINDOW_SECONDS = 30 * 24 * 3600  # 30 days
    PROMOTION_THRESHOLD = 0.02  # Challenger must beat champion Gini by this much

    def __init__(self, champion: ScorecardModel, challenger: XGBoostChallengerModel):
        self.champion = champion
        self.challenger = challenger
        self._history: deque[PredictionRecord] = deque(maxlen=10_000)

    def predict(self, features: dict) -> dict:
        """
        Run both models and return a combined result.

        Returns:
            {
                "champion_prob": float,  # P(repayment) from champion — used for decision
                "challenger_prob": float,  # P(repayment) from challenger — shadow only
                "champion_model": str,
                "challenger_model": str,
                "champion_score": int,  # Scorecard points
                "shap_top5": list[dict],  # SHAP explanations from challenger
            }
        """
        champion_prob = self.champion.predict_proba(features)
        challenger_prob = self.challenger.predict_proba(features)
        champion_score = self.champion.predict_score(features)
        shap_top5 = self.challenger.explain(features, top_n=5)

        record = PredictionRecord(
            timestamp=time.time(),
            champion_prob=champion_prob,
            challenger_prob=challenger_prob,
        )
        self._history.append(record)

        logger.info(
            "Champion=%.4f Challenger=%.4f delta=%.4f",
            champion_prob, challenger_prob, challenger_prob - champion_prob,
        )

        return {
            "champion_prob": champion_prob,
            "challenger_prob": challenger_prob,
            "champion_model": self.champion.version,
            "challenger_model": self.challenger.version,
            "champion_score": champion_score,
            "shap_top5": shap_top5,
        }

    def record_outcome(self, timestamp: float, actual_label: float):
        """Record the actual outcome for a past prediction (1=repaid, 0=defaulted)."""
        for record in self._history:
            if abs(record.timestamp - timestamp) < 1.0:
                record.actual_label = actual_label
                return True
        return False

    def check_promotion(self) -> dict:
        """
        Compare champion vs challenger on labeled predictions within
        the rolling window. Returns promotion recommendation.
        """
        cutoff = time.time() - self.ROLLING_WINDOW_SECONDS
        labeled = [
            r for r in self._history
            if r.actual_label is not None and r.timestamp >= cutoff
        ]

        if len(labeled) < 50:
            return {
                "should_promote": False,
                "reason": f"Insufficient labeled data ({len(labeled)}/50 minimum)",
                "champion_gini": None,
                "challenger_gini": None,
                "labeled_count": len(labeled),
            }

        actuals = [r.actual_label for r in labeled]
        champion_preds = [r.champion_prob for r in labeled]
        challenger_preds = [r.challenger_prob for r in labeled]

        champion_gini = self._gini_coefficient(actuals, champion_preds)
        challenger_gini = self._gini_coefficient(actuals, challenger_preds)
        delta = challenger_gini - champion_gini

        should_promote = delta >= self.PROMOTION_THRESHOLD

        if should_promote:
            logger.warning(
                "PROMOTION ALERT: Challenger Gini (%.4f) exceeds champion (%.4f) by %.4f",
                challenger_gini, champion_gini, delta,
            )

        return {
            "should_promote": should_promote,
            "reason": (
                f"Challenger Gini ({challenger_gini:.4f}) vs Champion ({champion_gini:.4f}), "
                f"delta={delta:+.4f}, threshold={self.PROMOTION_THRESHOLD}"
            ),
            "champion_gini": round(champion_gini, 4),
            "challenger_gini": round(challenger_gini, 4),
            "labeled_count": len(labeled),
        }

    @staticmethod
    def _gini_coefficient(actuals: list, predictions: list) -> float:
        """Compute Gini coefficient (2*AUC - 1) for model ranking."""
        import numpy as np

        actuals = np.array(actuals)
        predictions = np.array(predictions)

        if len(np.unique(actuals)) < 2:
            return 0.0

        # Sort by predicted probability descending
        order = np.argsort(-predictions)
        actuals_sorted = actuals[order]

        n = len(actuals)
        total_pos = actuals.sum()
        if total_pos == 0 or total_pos == n:
            return 0.0

        cum_pos = np.cumsum(actuals_sorted)
        # AUC via trapezoidal rule
        auc = np.sum(cum_pos[actuals_sorted == 0]) / (total_pos * (n - total_pos))
        gini = 2 * auc - 1
        return float(max(0.0, gini))

    @classmethod
    def load(cls, champion_path: str, challenger_path: str) -> "ChampionChallengerRouter":
        champion = ScorecardModel.load(champion_path)
        challenger = XGBoostChallengerModel.load(challenger_path)
        return cls(champion=champion, challenger=challenger)
