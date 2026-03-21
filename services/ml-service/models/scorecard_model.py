"""
WoE (Weight of Evidence) Scorecard champion model.

Uses scorecardpy-style WoE binning with a logistic regression backend.
Features are transformed to WoE values before prediction, which provides
both interpretability and monotonic risk ranking.

Feature set (from decision engine Stages 0-2):
  scDiasAtraso, cdcScore, carteraVencida, imss_tenure_months, lti,
  riskSeal_score, employer_tier, sector_risk, afore_regularity, monthly_salary
"""

import numpy as np
import joblib


class ScorecardModel:
    """
    WoE scorecard champion model for loan underwriting.

    Each feature is binned into WoE buckets at training time. At inference,
    raw feature values are mapped to their WoE values, then fed through
    a logistic regression to produce P(default).
    """

    FEATURE_ORDER = [
        "scDiasAtraso",
        "cdcScore",
        "carteraVencida",
        "imss_tenure_months",
        "lti",
        "riskSeal_score",
        "employer_tier",
        "sector_risk",
        "afore_regularity",
        "monthly_salary",
    ]

    def __init__(self, woe_bins, iv_values, lr_model, base_score=600, pdo=50):
        """
        Args:
            woe_bins: dict mapping feature name -> list of (upper_bound, woe_value) tuples
            iv_values: dict mapping feature name -> IV (Information Value)
            lr_model: fitted sklearn LogisticRegression on WoE-transformed features
            base_score: base scorecard points (default 600)
            pdo: points to double odds (default 50)
        """
        self.woe_bins = woe_bins
        self.iv_values = iv_values
        self.lr_model = lr_model
        self.base_score = base_score
        self.pdo = pdo
        self.version = "scorecard_champion_v2.0"

    def _apply_woe(self, feature_name: str, value: float) -> float:
        """Map a raw feature value to its WoE bucket value."""
        bins = self.woe_bins.get(feature_name, [])
        for upper_bound, woe_val in bins:
            if value <= upper_bound:
                return woe_val
        # If value exceeds all bounds, use last bin
        return bins[-1][1] if bins else 0.0

    def transform_to_woe(self, features: dict) -> np.ndarray:
        """Transform raw features to WoE values."""
        return np.array([
            self._apply_woe(f, features.get(f, 0.0))
            for f in self.FEATURE_ORDER
        ], dtype=np.float64)

    def predict_proba(self, features: dict) -> float:
        """Return P(repayment) in [0.0, 1.0]. Higher = safer borrower."""
        woe_vector = self.transform_to_woe(features)
        prob_default = self.lr_model.predict_proba([woe_vector])[0][1]
        return float(1.0 - prob_default)

    def predict_score(self, features: dict) -> int:
        """Return a credit scorecard point value (higher = safer)."""
        prob_repay = self.predict_proba(features)
        odds = max(prob_repay / max(1.0 - prob_repay, 1e-10), 1e-10)
        score = self.base_score + self.pdo * np.log(odds) / np.log(2)
        return int(np.clip(score, 300, 900))

    @classmethod
    def load(cls, path: str) -> "ScorecardModel":
        return joblib.load(path)

    def save(self, path: str):
        joblib.dump(self, path)
