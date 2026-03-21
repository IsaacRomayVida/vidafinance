"""
XGBoost Challenger model with Platt calibration and SHAP support.

Operates on raw (untransformed) features. Uses CalibratedClassifierCV
for Platt scaling to produce well-calibrated probabilities.
"""

import numpy as np
import joblib


class PlattCalibratedXGB:
    """Wrapper that applies Platt scaling (sigmoid calibration) to XGBoost predictions."""

    def __init__(self, xgb_model, platt_lr):
        self.xgb_model = xgb_model
        self.platt_lr = platt_lr

    def predict_proba(self, X):
        raw_probs = self.xgb_model.predict_proba(X)[:, 1].reshape(-1, 1)
        return self.platt_lr.predict_proba(raw_probs)


class XGBChallenger:
    """
    XGBoost challenger model with calibrated probabilities and SHAP explanations.

    The model stores both the raw XGBoost booster (for SHAP) and a
    CalibratedClassifierCV wrapper (for calibrated probabilities).
    """

    FEATURE_SET = [
        # Champion features
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
        # Challenger-only features
        "scCuentasActivas",
        "belvo_cash_flow_avg",
        "employer_score",
        "payroll_regularity",
    ]

    def __init__(self, calibrated_model, raw_xgb_model, feature_names):
        self.calibrated_model = calibrated_model
        self.raw_xgb_model = raw_xgb_model
        self.feature_names = feature_names
        self.version = "xgb_challenger_v2.0"
        self._explainer = None

    def _build_vector(self, features: dict) -> np.ndarray:
        return np.array(
            [features.get(f, 0.0) for f in self.feature_names], dtype=np.float64
        )

    def predict_proba(self, features: dict) -> float:
        """Return calibrated P(repayment) in [0.0, 1.0]."""
        x = self._build_vector(features).reshape(1, -1)
        prob = self.calibrated_model.predict_proba(x)[0, 1]
        return float(prob)

    def explain(self, features: dict, top_n: int = 5) -> list[dict]:
        """
        Return top-N SHAP feature contributions for this prediction.

        Returns list of dicts: [{"feature": name, "shap_value": float}, ...]
        sorted by absolute SHAP value descending.
        """
        import shap

        if self._explainer is None:
            self._explainer = shap.TreeExplainer(self.raw_xgb_model)

        x = self._build_vector(features).reshape(1, -1)
        shap_values = self._explainer.shap_values(x)

        # shap_values shape: (1, n_features) for binary classification
        if isinstance(shap_values, list):
            # For binary classification, take positive class
            sv = shap_values[1][0] if len(shap_values) > 1 else shap_values[0][0]
        else:
            sv = shap_values[0]

        # Pair features with SHAP values and sort by absolute value
        contributions = [
            {"feature": name, "shap_value": round(float(val), 6)}
            for name, val in zip(self.feature_names, sv)
        ]
        contributions.sort(key=lambda c: abs(c["shap_value"]), reverse=True)
        return contributions[:top_n]

    @classmethod
    def load(cls, path: str) -> "XGBChallenger":
        return joblib.load(path)

    def save(self, path: str):
        joblib.dump(self, path)
