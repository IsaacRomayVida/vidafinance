"""
Train the WoE scorecard champion model (v2).

Uses scorecardpy-style WoE binning with IV feature selection on synthetic
labeled data calibrated to VIDA's Mexican payroll borrower profile.
Features are selected from the decision engine Stages 0-2.

Output: models/scorecard_champion_v2.joblib

Usage: python scripts/train_scorecard_champion.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score

from models.scorecard_model import ScorecardModel

SEED = 42
rng = np.random.default_rng(SEED)
N = 8000


def generate_synthetic_dataset(n: int, rng: np.random.Generator) -> pd.DataFrame:
    """
    Generate synthetic data with the champion feature set.

    Features reflect decision engine Stages 0-2 outputs for Mexican
    payroll borrowers with bureau data from SoftCrédito/CDC.
    """
    # scDiasAtraso: days past due from bureau (0 = current, higher = worse)
    # ~40% have some delinquency, creating clear separation for WoE bins
    sc_dias_atraso = rng.exponential(scale=15, size=n).clip(0, 180)
    sc_dias_atraso[rng.random(n) < 0.4] = 0  # 40% have no delinquency

    # cdcScore: bureau credit score (300-850 range)
    cdc_score = rng.normal(600, 100, size=n).clip(300, 850)

    # carteraVencida: past-due portfolio amount in MXN (0 for most)
    cartera_vencida = rng.exponential(scale=2000, size=n).clip(0, 50000)
    cartera_vencida[rng.random(n) < 0.7] = 0  # 70% have no past-due

    # imss_tenure_months: IMSS employment tenure
    imss_tenure = rng.exponential(scale=24, size=n).clip(0, 180)

    # lti: loan-to-income ratio
    lti = rng.uniform(0.02, 0.50, size=n)

    # riskSeal_score: device/fraud risk score (0-100, lower = safer)
    risk_seal = rng.beta(2, 5, size=n) * 100

    # employer_tier: 1=best, 2=medium, 3=risky
    employer_tier = rng.choice([1, 2, 3], size=n, p=[0.3, 0.5, 0.2]).astype(float)

    # sector_risk: industry risk score (0-1, higher = riskier)
    sector_risk = rng.beta(3, 4, size=n)

    # afore_regularity: AFORE contribution regularity (0-1, higher = more regular)
    afore_regularity = rng.beta(5, 2, size=n)

    # monthly_salary: in MXN
    monthly_salary = rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(7000, 60000)

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
    })

    # Generate log-odds of default. scDiasAtraso is the strongest predictor
    # (SHAP=0.24 in production). Coefficients are in log-odds space so that
    # each feature drives meaningful IV/WoE separation.
    logit = (
        + 2.0 * np.clip(sc_dias_atraso / 20, 0, 4)        # days late → default (strongest)
        - 1.5 * np.clip((cdc_score - 400) / 300, 0, 1)    # higher score → repay
        + 1.2 * np.clip(cartera_vencida / 3000, 0, 3)     # past-due → default
        - 1.5 * np.clip(imss_tenure / 36, 0, 2)           # tenure → repay
        + 1.0 * np.clip(lti / 0.15, 0, 3)                 # high LTI → default
        + 0.6 * np.clip(risk_seal / 40, 0, 2)             # fraud risk → default
        + 0.5 * (employer_tier - 1)                        # tier 3 → default
        + 0.5 * sector_risk * 2                            # risky sector → default
        - 0.5 * afore_regularity * 2                       # regularity → repay
        - 0.8 * np.clip(monthly_salary / 15000, 0, 2)     # salary → repay
        - 0.5                                               # base intercept
    )

    # Hard rules matching business logic
    logit[sc_dias_atraso > 30] += 2.0
    logit[cartera_vencida > 5000] += 1.5
    logit[imss_tenure < 3] += 2.5

    noise = rng.normal(0, 0.3, size=n)
    prob_default = 1.0 / (1.0 + np.exp(-(logit + noise)))
    df["target"] = (rng.random(n) < prob_default).astype(int)  # 1 = default

    return df


def compute_woe_bins(df: pd.DataFrame, feature: str, target: str, n_bins: int = 5) -> tuple:
    """
    Compute WoE bins for a single feature.

    Returns:
        (bins, iv) where bins is list of (upper_bound, woe_value) and iv is float.
    """
    feature_data = df[[feature, target]].copy()
    feature_data["bin"] = pd.qcut(feature_data[feature], q=n_bins, duplicates="drop")

    grouped = feature_data.groupby("bin", observed=True)[target].agg(["sum", "count"])
    grouped.columns = ["bad", "total"]
    grouped["good"] = grouped["total"] - grouped["bad"]

    total_bad = grouped["bad"].sum()
    total_good = grouped["good"].sum()

    # Avoid division by zero with Laplace smoothing
    grouped["dist_bad"] = (grouped["bad"] + 0.5) / (total_bad + 0.5 * len(grouped))
    grouped["dist_good"] = (grouped["good"] + 0.5) / (total_good + 0.5 * len(grouped))
    grouped["woe"] = np.log(grouped["dist_good"] / grouped["dist_bad"])
    grouped["iv_component"] = (grouped["dist_good"] - grouped["dist_bad"]) * grouped["woe"]

    iv = grouped["iv_component"].sum()

    bins = []
    for interval in grouped.index:
        bins.append((float(interval.right), float(grouped.loc[interval, "woe"])))

    # Sort by upper bound
    bins.sort(key=lambda x: x[0])
    return bins, float(iv)


def train_and_save(output_path: str):
    df = generate_synthetic_dataset(N, rng)

    features = ScorecardModel.FEATURE_ORDER
    target = "target"

    # Compute WoE bins and IV for each feature
    woe_bins = {}
    iv_values = {}
    print("\nFeature IV values:")
    print("-" * 40)

    for feat in features:
        bins, iv = compute_woe_bins(df, feat, target, n_bins=5)
        woe_bins[feat] = bins
        iv_values[feat] = iv
        status = "✓" if iv >= 0.1 else "weak"
        print(f"  {feat:25s} IV={iv:.4f} [{status}]")

    # Select features with IV >= 0.02 (keep all, but flag weak ones)
    selected = [f for f in features if iv_values[f] >= 0.02]
    print(f"\nSelected {len(selected)}/{len(features)} features (IV ≥ 0.02)")

    # Transform features to WoE values
    model_template = ScorecardModel(woe_bins=woe_bins, iv_values=iv_values, lr_model=None)

    X_woe = np.array([
        model_template.transform_to_woe(row.to_dict())
        for _, row in df[features].iterrows()
    ])
    y = df[target].values

    # Train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        X_woe, y, test_size=0.2, random_state=SEED, stratify=y
    )

    # Train logistic regression on WoE-transformed features
    lr = LogisticRegression(
        C=1.0, max_iter=1000, random_state=SEED, class_weight="balanced"
    )
    lr.fit(X_train, y_train)

    # Evaluate
    train_auc = roc_auc_score(y_train, lr.predict_proba(X_train)[:, 1])
    test_auc = roc_auc_score(y_test, lr.predict_proba(X_test)[:, 1])
    default_rate = y.mean()

    print(f"\nDefault rate              : {default_rate:.1%}")
    print(f"Train AUC                 : {train_auc:.4f}")
    print(f"Test AUC                  : {test_auc:.4f}")
    print(f"Test Gini                 : {2 * test_auc - 1:.4f}")

    # Save model
    model = ScorecardModel(
        woe_bins=woe_bins,
        iv_values=iv_values,
        lr_model=lr,
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model.save(output_path)
    print(f"Model saved to            : {output_path}")
    return model


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "models", "scorecard_champion_v2.joblib")
    train_and_save(os.path.abspath(out))
