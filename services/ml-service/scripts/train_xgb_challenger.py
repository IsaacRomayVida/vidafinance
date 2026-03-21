"""
Train XGBoost Challenger model (v2) with Platt-scale calibration.

Uses the expanded feature set (champion + 4 challenger-only features).
Saves both the raw XGBoost model (for SHAP) and a CalibratedClassifierCV
wrapper (for calibrated probabilities).

Usage: python scripts/train_xgb_challenger.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score
from sklearn.linear_model import LogisticRegression
import xgboost as xgb

from models.xgb_model import XGBChallenger, PlattCalibratedXGB

SEED = 42
rng = np.random.default_rng(SEED)
N = 10000


def generate_synthetic_data(n: int, rng: np.random.Generator) -> pd.DataFrame:
    """
    Generate synthetic borrower data with the full XGBoost feature set.

    Includes all champion features plus 4 challenger-only features:
    scCuentasActivas, belvo_cash_flow_avg, employer_score, payroll_regularity.
    """
    df = pd.DataFrame()

    # Champion features (same distributions as scorecard training)
    df["scDiasAtraso"] = rng.exponential(scale=15, size=n).clip(0, 180).astype(float)
    df["cdcScore"] = rng.normal(loc=600, scale=100, size=n).clip(300, 850).astype(float)
    df["carteraVencida"] = rng.exponential(scale=5000, size=n).clip(0, 100000).astype(float)
    df["imss_tenure_months"] = rng.exponential(scale=24, size=n).clip(0, 180).astype(float)
    df["monthly_salary"] = rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(7000, 60000)

    principal = rng.uniform(500, 8000, size=n)
    df["lti"] = (principal / df["monthly_salary"]).clip(0.01, 1.0)

    df["riskSeal_score"] = rng.normal(loc=50, scale=20, size=n).clip(0, 100).astype(float)
    df["employer_tier"] = rng.choice([1, 2, 3, 4, 5], size=n, p=[0.1, 0.2, 0.4, 0.2, 0.1]).astype(float)
    df["sector_risk"] = rng.choice([1, 2, 3, 4, 5], size=n, p=[0.15, 0.25, 0.30, 0.20, 0.10]).astype(float)
    df["afore_regularity"] = rng.beta(a=5, b=2, size=n).clip(0, 1)

    # Challenger-only features
    df["scCuentasActivas"] = rng.poisson(lam=3, size=n).clip(0, 20).astype(float)
    df["belvo_cash_flow_avg"] = rng.lognormal(mean=9.0, sigma=0.8, size=n).clip(2000, 80000)
    df["employer_score"] = rng.normal(loc=65, scale=15, size=n).clip(0, 100).astype(float)
    df["payroll_regularity"] = rng.beta(a=6, b=2, size=n).clip(0, 1)

    # Target with threshold-based signal for clear bin separation
    score = np.zeros(n)

    # Champion features
    score += 0.12 * (df["scDiasAtraso"] < 5).astype(float)
    score -= 0.10 * (df["scDiasAtraso"] > 60).astype(float)
    score += 0.12 * (df["cdcScore"] > 700).astype(float)
    score -= 0.08 * (df["cdcScore"] < 450).astype(float)
    score += 0.08 * (df["carteraVencida"] < 1000).astype(float)
    score -= 0.06 * (df["carteraVencida"] > 20000).astype(float)
    score += 0.10 * (df["imss_tenure_months"] > 24).astype(float)
    score -= 0.08 * (df["imss_tenure_months"] < 6).astype(float)
    score += 0.08 * (df["lti"] < 0.15).astype(float)
    score -= 0.06 * (df["lti"] > 0.35).astype(float)
    score += 0.06 * (df["riskSeal_score"] > 65).astype(float)
    score -= 0.04 * (df["riskSeal_score"] < 30).astype(float)
    score += 0.06 * (df["employer_tier"] <= 2).astype(float)
    score -= 0.04 * (df["employer_tier"] >= 4).astype(float)
    score += 0.04 * (df["sector_risk"] <= 2).astype(float)
    score -= 0.03 * (df["sector_risk"] >= 4).astype(float)
    score += 0.04 * (df["afore_regularity"] > 0.8).astype(float)
    score += 0.04 * (df["monthly_salary"] > 20000).astype(float)

    # Challenger-only features (additional signal)
    score += 0.05 * (df["scCuentasActivas"] <= 3).astype(float)
    score -= 0.04 * (df["scCuentasActivas"] > 8).astype(float)
    score += 0.06 * (df["belvo_cash_flow_avg"] > 20000).astype(float)
    score -= 0.04 * (df["belvo_cash_flow_avg"] < 5000).astype(float)
    score += 0.05 * (df["employer_score"] > 70).astype(float)
    score -= 0.04 * (df["employer_score"] < 40).astype(float)
    score += 0.05 * (df["payroll_regularity"] > 0.8).astype(float)
    score -= 0.03 * (df["payroll_regularity"] < 0.4).astype(float)

    # Non-linear interactions XGBoost should capture
    score += 0.05 * (df["cdcScore"] > 700).astype(float) * (df["scDiasAtraso"] < 10).astype(float)
    score -= 0.05 * (df["lti"] > 0.3).astype(float) * (df["employer_tier"] >= 4).astype(float)
    score += 0.03 * (df["payroll_regularity"] > 0.8).astype(float) * (df["employer_score"] > 70).astype(float)

    # Hard rules
    score[df["imss_tenure_months"] < 3] -= 0.30
    score[df["scDiasAtraso"] > 90] -= 0.20

    noise = rng.normal(0, 0.05, size=n)
    prob = np.clip(score + noise + 0.50, 0, 1)
    df["target"] = (prob >= 0.50).astype(int)

    return df


def train_and_save(output_path: str):
    df = generate_synthetic_data(N, rng)

    feature_names = XGBChallenger.FEATURE_SET
    X = df[feature_names].values
    y = df["target"].values

    # 3-way split: train (60%), calibration (20%), test (20%)
    X_train_cal, X_test, y_train_cal, y_test = train_test_split(
        X, y, test_size=0.2, random_state=SEED, stratify=y
    )
    X_train, X_cal, y_train, y_cal = train_test_split(
        X_train_cal, y_train_cal, test_size=0.25, random_state=SEED, stratify=y_train_cal
    )

    print("=" * 60)
    print("XGBoost Challenger Training")
    print("=" * 60)
    print(f"Train: {len(X_train)}, Calibration: {len(X_cal)}, Test: {len(X_test)}")

    # Train XGBoost
    pos_weight = (y_train == 0).sum() / max((y_train == 1).sum(), 1)
    raw_xgb = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=5,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=pos_weight,
        random_state=SEED,
        eval_metric="auc",
        use_label_encoder=False,
    )
    raw_xgb.fit(
        X_train, y_train,
        eval_set=[(X_cal, y_cal)],
        verbose=False,
    )

    # Raw AUC
    raw_train_auc = roc_auc_score(y_train, raw_xgb.predict_proba(X_train)[:, 1])
    raw_test_auc = roc_auc_score(y_test, raw_xgb.predict_proba(X_test)[:, 1])
    print(f"\nRaw XGBoost:")
    print(f"  Train AUC: {raw_train_auc:.4f}")
    print(f"  Test AUC:  {raw_test_auc:.4f}")

    # Manual Platt-scale calibration: fit LR on XGBoost's raw probabilities
    # using the held-out calibration set
    cal_raw_probs = raw_xgb.predict_proba(X_cal)[:, 1].reshape(-1, 1)
    platt_lr = LogisticRegression(C=1e10, max_iter=1000, random_state=SEED)
    platt_lr.fit(cal_raw_probs, y_cal)

    # Build a simple calibrated wrapper
    calibrated = PlattCalibratedXGB(raw_xgb, platt_lr)

    cal_test_auc = roc_auc_score(y_test, calibrated.predict_proba(X_test)[:, 1])
    print(f"\nCalibrated XGBoost:")
    print(f"  Test AUC:  {cal_test_auc:.4f}")

    if cal_test_auc < 0.85:
        print(f"\nWARNING: Test AUC {cal_test_auc:.4f} < 0.85 target")
    else:
        print(f"\n  AUC target met (>= 0.85)")

    # Feature importance
    print(f"\nFeature importance (gain):")
    importances = raw_xgb.feature_importances_
    for name, imp in sorted(zip(feature_names, importances), key=lambda x: -x[1]):
        print(f"  {name:25s}  {imp:.4f}")

    # Save model
    model = XGBChallenger(
        calibrated_model=calibrated,
        raw_xgb_model=raw_xgb,
        feature_names=feature_names,
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model.save(output_path)
    print(f"\nModel saved to: {output_path}")

    return model


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "models", "xgb_challenger_v2.joblib")
    train_and_save(os.path.abspath(out))
