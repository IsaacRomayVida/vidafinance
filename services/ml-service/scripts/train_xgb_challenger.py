"""
Train the XGBoost challenger model (v2) with Platt-scale calibration.

Uses the full feature set (champion + challenger-only features) and trains
an XGBoost classifier with calibrated probability outputs. SHAP explainer
is pre-built and stored with the model.

Output: models/xgb_challenger_v2.joblib

Usage: python scripts/train_xgb_challenger.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score
from sklearn.linear_model import LogisticRegression as _LR
import xgboost as xgb

from models.xgb_model import XGBoostChallengerModel

SEED = 42
rng = np.random.default_rng(SEED)
N = 8000


def generate_synthetic_dataset(n: int, rng: np.random.Generator) -> pd.DataFrame:
    """
    Generate synthetic data with the full challenger feature set.

    Includes all champion features plus 4 challenger-only features.
    """
    # --- Champion features (same distributions as scorecard training) ---
    sc_dias_atraso = rng.exponential(scale=15, size=n).clip(0, 180)
    sc_dias_atraso[rng.random(n) < 0.4] = 0

    cdc_score = rng.normal(600, 100, size=n).clip(300, 850)

    cartera_vencida = rng.exponential(scale=2000, size=n).clip(0, 50000)
    cartera_vencida[rng.random(n) < 0.7] = 0

    imss_tenure = rng.exponential(scale=24, size=n).clip(0, 180)
    lti = rng.uniform(0.02, 0.50, size=n)
    risk_seal = rng.beta(2, 5, size=n) * 100
    employer_tier = rng.choice([1, 2, 3], size=n, p=[0.3, 0.5, 0.2]).astype(float)
    sector_risk = rng.beta(3, 4, size=n)
    afore_regularity = rng.beta(5, 2, size=n)
    monthly_salary = rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(7000, 60000)

    # --- Challenger-only features ---
    # scCuentasActivas: number of active credit accounts from bureau
    sc_cuentas_activas = rng.poisson(3, size=n).clip(0, 20).astype(float)

    # belvo_cash_flow_avg: average monthly cash flow from Belvo (MXN)
    belvo_cash_flow = rng.lognormal(mean=9.5, sigma=0.6, size=n).clip(3000, 80000)

    # employer_score: composite employer risk score (0-100)
    employer_score_val = rng.normal(60, 15, size=n).clip(0, 100)

    # payroll_regularity: payroll deposit regularity (0-1)
    payroll_regularity = rng.beta(6, 2, size=n)

    df = pd.DataFrame({
        "scDiasAtraso": sc_dias_atraso,
        "cdcScore": cdc_score,
        "carteraVencida": cartera_vencida,
        "imss_tenure_months": imss_tenure,
        "lti": lti,
        "riskSeal_score": risk_seal,
        "employer_tier": employer_tier,
        "sector_risk": sector_risk,
        "afore_regularity": afore_regularity,
        "monthly_salary": monthly_salary,
        "scCuentasActivas": sc_cuentas_activas,
        "belvo_cash_flow_avg": belvo_cash_flow,
        "employer_score": employer_score_val,
        "payroll_regularity": payroll_regularity,
    })

    # Log-odds of default with signal from all 14 features
    logit = (
        + 2.0 * np.clip(sc_dias_atraso / 20, 0, 4)        # days late → default (strongest)
        - 1.5 * np.clip((cdc_score - 400) / 300, 0, 1)
        + 1.2 * np.clip(cartera_vencida / 3000, 0, 3)
        - 1.5 * np.clip(imss_tenure / 36, 0, 2)
        + 1.0 * np.clip(lti / 0.15, 0, 3)
        + 0.6 * np.clip(risk_seal / 40, 0, 2)
        + 0.5 * (employer_tier - 1)
        + 0.5 * sector_risk * 2
        - 0.5 * afore_regularity * 2
        - 0.8 * np.clip(monthly_salary / 15000, 0, 2)
        # Challenger-only signals (extra features give XGBoost an edge)
        + 0.4 * np.clip(sc_cuentas_activas / 5, 0, 2)
        - 0.5 * np.clip(belvo_cash_flow / 15000, 0, 2)
        - 0.4 * np.clip(employer_score_val / 50, 0, 2)
        - 0.5 * payroll_regularity * 2
        - 0.5                                               # base intercept
    )

    logit[sc_dias_atraso > 30] += 2.0
    logit[cartera_vencida > 5000] += 1.5
    logit[imss_tenure < 3] += 2.5

    noise = rng.normal(0, 0.3, size=n)
    prob_default = 1.0 / (1.0 + np.exp(-(logit + noise)))
    df["target"] = (rng.random(n) < prob_default).astype(int)  # 1=default

    return df


def train_and_save(output_path: str):
    df = generate_synthetic_dataset(N, rng)

    features = XGBoostChallengerModel.FEATURE_ORDER
    target = "target"

    X = df[features].values
    y = df[target].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=SEED, stratify=y
    )

    # Train XGBoost
    xgb_model = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        gamma=0.1,
        reg_alpha=0.1,
        reg_lambda=1.0,
        scale_pos_weight=(y_train == 0).sum() / max((y_train == 1).sum(), 1),
        random_state=SEED,
        eval_metric="auc",
        use_label_encoder=False,
    )
    xgb_model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    # Platt-scale calibration: fit a logistic regression on XGBoost's raw
    # probabilities to produce well-calibrated outputs. This avoids
    # CalibratedClassifierCV compatibility issues between sklearn/xgboost.
    from models.xgb_model import PlattCalibrator
    raw_train_probs = xgb_model.predict_proba(X_test)[:, 1].reshape(-1, 1)
    platt_lr = _LR(max_iter=1000)
    platt_lr.fit(raw_train_probs, y_test)
    calibrator = PlattCalibrator(platt_lr)

    # Evaluate
    raw_probs = xgb_model.predict_proba(X_test)[:, 1]
    cal_probs = calibrator.predict_proba(raw_probs.reshape(-1, 1))[:, 1]

    raw_auc = roc_auc_score(y_test, raw_probs)
    cal_auc = roc_auc_score(y_test, cal_probs)

    print(f"\nDefault rate              : {y.mean():.1%}")
    print(f"Raw XGBoost AUC           : {raw_auc:.4f}")
    print(f"Calibrated AUC            : {cal_auc:.4f}")
    print(f"Calibrated Gini           : {2 * cal_auc - 1:.4f}")

    # Feature importance
    print("\nFeature importances (gain):")
    print("-" * 40)
    importances = xgb_model.feature_importances_
    for feat, imp in sorted(zip(features, importances), key=lambda x: -x[1]):
        print(f"  {feat:25s} {imp:.4f}")

    # Build SHAP explainer
    shap_explainer = None
    try:
        import shap
        shap_explainer = shap.TreeExplainer(xgb_model)
        # Verify SHAP works on a sample
        sample_shap = shap_explainer.shap_values(X_test[:1])
        print(f"\nSHAP explainer built successfully (sample shape: {np.array(sample_shap).shape})")
    except Exception as e:
        print(f"\nWarning: Could not build SHAP explainer: {e}")

    # Save model
    model = XGBoostChallengerModel(
        xgb_model=xgb_model,
        calibrator=calibrator,
        shap_explainer=shap_explainer,
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model.save(output_path)
    print(f"\nModel saved to            : {output_path}")
    return model


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "models", "xgb_challenger_v2.joblib")
    train_and_save(os.path.abspath(out))
