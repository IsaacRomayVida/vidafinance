"""
WoE Scorecard Champion model.

Uses Weight of Evidence (WoE) transformed features with logistic regression.
Trained with scorecardpy for WoE binning and IV-based feature selection.
"""

import numpy as np
import joblib


def _distance_to_bin(bin_entry: dict, value: float) -> float:
    """How far `value` sits outside `bin_entry`'s range; 0.0 if inside."""
    lo, hi = bin_entry["range"]
    if value < lo:
        return lo - value
    if value >= hi:
        return value - hi
    return 0.0


def lookup_woe(bins: list, value: float) -> float:
    """Return the WoE of the bin holding `value`, clamping to the nearest.

    Module-level rather than a method so scripts/train_scorecard_champion.py
    transforms its training frame through this exact function instead of its
    own copy of the loop. It previously had one, with the same
    `bins[-1]` out-of-range fallback, and a fix applied to only one of the two
    would have silently retrained the model under different semantics than it
    is served with. See ScorecardChampion._lookup_woe for the defect.
    """
    if not bins:
        return 0.0
    # Containment first, and on its own. The bins are contiguous, so the `hi`
    # of one is the `lo` of the next and both sit at distance 0 from a value on
    # that shared edge; resolving by distance alone would hand the boundary to
    # whichever bin came first in the list rather than to the one whose
    # half-open [lo, hi) actually contains it.
    for bin_entry in bins:
        lo, hi = bin_entry["range"]
        if lo <= value < hi:
            return bin_entry["woe"]
    return min(bins, key=lambda b: _distance_to_bin(b, value))["woe"]


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
        """Find the WoE value for a given feature and raw value.

        A value outside every stored range clamps to the NEAREST bin.

        The previous fallback returned `bins[-1]["woe"]` — the highest bin —
        for anything unmatched, in either direction. Above the ceiling that is
        already the nearest bin and the answer was right; below the floor it
        was the opposite end of the scorecard.

        The edges are not real boundaries. `pd.qcut` built these bins over the
        synthetic training frame (scripts/train_scorecard_champion.py:149), so
        the lowest `lo` is that frame's minimum and the highest `hi` is its
        maximum, and the frame clips `monthly_salary` to [7000, 60000] and
        `cdcScore` to [300, 850] (:41, :50). Production clips neither, and
        `_apply_woe` reads an ABSENT feature as a raw 0.0 — under both floors.

        Every fitted LR coefficient is positive, so the highest bin is the
        safest band. Concretely, before this change:

            cdcScore       250 -> +0.6153  (the 687-850 band) not -0.5007
            monthly_salary 5000 -> +0.5839 (the 24.6k-60k band) not -0.4879

        A 250 bureau score on a 5,000 salary produced a WoE vector identical
        to an 800 on 50,000, and the same P(repayment) = 0.9936. Salary 6,000
        scored 0.9636 against salary 7,500's 0.9060 — monotonicity inverted at
        the bottom edge.

        Nearest-bin clamping is the ordering the bins already encode, not a
        risk-appetite setting. Whether an applicant below the training floor
        should be scored at all rather than routed out-of-population is a
        commercial question and is NOT answered here.

        See tests/test_scorecard_woe_bins.py.
        """
        return lookup_woe(self.woe_bins.get(feature), value)

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
