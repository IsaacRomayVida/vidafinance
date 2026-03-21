"""
XGBoost challenger model with Platt-scale calibration and SHAP explanations.

Uses the full feature set from the decision engine (champion features +
scCuentasActivas, belvo_cash_flow_avg, employer_score, payroll_regularity).
"""

import numpy as np
import joblib


class PlattCalibrator:
    """Lightweight Platt-scale calibrator wrapping a logistic regression
    fitted on the raw XGBoost probability output."""

    def __init__(self, lr_model):
        self.lr_model = lr_model

    def predict_proba(self, X):
        """Accept raw features, get XGBoost proba, then calibrate.

        When used standalone (without the XGBoost model calling through),
        X should already be the raw probability column reshaped to (-1, 1).
        """
        return self.lr_model.predict_proba(X)


class XGBoostChallengerModel:
    """
    XGBoost challenger model for loan underwriting.

    Trained on raw (non-WoE) features with Platt-scale calibration
    for well-calibrated probability outputs. SHAP values are computed
    per prediction for adverse action notices.
    """

    FEATURE_ORDER = [
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

    def __init__(self, xgb_model, calibrator, shap_explainer=None):
        """
        Args:
            xgb_model: fitted xgboost.XGBClassifier
            calibrator: fitted sklearn CalibratedClassifierCV or similar
            shap_explainer: optional pre-built shap.TreeExplainer
        """
        self.xgb_model = xgb_model
        self.calibrator = calibrator
        self._shap_explainer = shap_explainer
        self.version = "xgb_challenger_v2.0"

    def _build_vector(self, features: dict) -> np.ndarray:
        """Build feature vector in the correct order."""
        return np.array(
            [features.get(f, 0.0) for f in self.FEATURE_ORDER],
            dtype=np.float64,
        )

    def predict_proba(self, features: dict) -> float:
        """Return calibrated P(repayment) in [0.0, 1.0]."""
        x = self._build_vector(features).reshape(1, -1)
        raw_prob = self.xgb_model.predict_proba(x)[0][1]
        cal_prob = self.calibrator.predict_proba(np.array([[raw_prob]]))[0][1]
        return float(1.0 - cal_prob)

    def predict_proba_raw(self, features: dict) -> float:
        """Return uncalibrated P(default) from XGBoost directly."""
        x = self._build_vector(features).reshape(1, -1)
        return float(self.xgb_model.predict_proba(x)[0][1])

    def explain(self, features: dict, top_n: int = 5) -> list[dict]:
        """
        Return top-N SHAP feature contributions for a single prediction.

        Each entry: {"feature": name, "shap_value": float, "raw_value": float}
        Sorted by absolute SHAP value descending.
        """
        if self._shap_explainer is None:
            try:
                import shap
                self._shap_explainer = shap.TreeExplainer(self.xgb_model)
            except Exception:
                return []

        x = self._build_vector(features).reshape(1, -1)
        shap_values = self._shap_explainer.shap_values(x)

        # shap_values shape: (1, n_features) for binary classification
        if isinstance(shap_values, list):
            # For older SHAP versions that return [class0, class1]
            sv = shap_values[1][0]
        else:
            sv = shap_values[0]

        contributions = []
        for i, feat_name in enumerate(self.FEATURE_ORDER):
            contributions.append({
                "feature": feat_name,
                "shap_value": round(float(sv[i]), 4),
                "raw_value": round(float(features.get(feat_name, 0.0)), 4),
            })

        contributions.sort(key=lambda c: abs(c["shap_value"]), reverse=True)
        return contributions[:top_n]

    @classmethod
    def load(cls, path: str) -> "XGBoostChallengerModel":
        return joblib.load(path)

    def save(self, path: str):
        joblib.dump(self, path)
