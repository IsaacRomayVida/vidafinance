"""
WoE Scorecard Champion model.

Uses Weight of Evidence (WoE) transformed features with logistic regression.
Trained with scorecardpy for WoE binning and IV-based feature selection.
"""

import numpy as np
import joblib


class ScorecardChampion:
    """
    WoE Logistic Regression scorecard model.

    Stores WoE bins and a fitted LR model. At prediction time, raw features
    are transformed to WoE values using the stored bins, then scored by the LR.
    """

    FEATURE_SET = [
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

    def __init__(self, woe_bins, iv_values, lr_model, selected_features):
        self.woe_bins = woe_bins
        self.iv_values = iv_values
        self.lr_model = lr_model
        self.selected_features = selected_features
        self.version = "scorecard_champion_v2.0"

    def _apply_woe(self, features: dict) -> np.ndarray:
        """Transform raw feature values to WoE values using stored bins."""
        woe_values = []
        for feat in self.selected_features:
            raw_val = features.get(feat, 0.0)
            woe_val = self._lookup_woe(feat, raw_val)
            woe_values.append(woe_val)
        return np.array(woe_values, dtype=np.float64)

    def _lookup_woe(self, feature: str, value: float) -> float:
        """Find the WoE value for a given feature and raw value."""
        if feature not in self.woe_bins:
            return 0.0
        bins = self.woe_bins[feature]
        for bin_entry in bins:
            lo, hi = bin_entry["range"]
            if lo <= value < hi:
                return bin_entry["woe"]
        # Fallback: use last bin
        if bins:
            return bins[-1]["woe"]
        return 0.0

    def predict_proba(self, features: dict) -> float:
        """Return P(repayment) in [0.0, 1.0]. Higher = safer borrower."""
        x_woe = self._apply_woe(features).reshape(1, -1)
        prob = self.lr_model.predict_proba(x_woe)[0, 1]
        return float(prob)

    @classmethod
    def load(cls, path: str) -> "ScorecardChampion":
        return joblib.load(path)

    def save(self, path: str):
        joblib.dump(self, path)
