"""
Train WoE Scorecard Champion model (v2).

Generates synthetic data with the expanded VIDA feature set, applies WoE
binning with IV-based feature selection (IV >= 0.1), trains a logistic
regression on WoE-transformed features, and saves the artifact.

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

from models.scorecard_model import ScorecardChampion, lookup_woe

SEED = 42
rng = np.random.default_rng(SEED)
N = 10000
IV_THRESHOLD = 0.1


def generate_synthetic_data(n: int, rng: np.random.Generator) -> pd.DataFrame:
    """
    Generate synthetic borrower data matching VIDA's expanded feature set.

    Features reflect Mexican payroll lending population with realistic
    distributions and correlations.
    """
    df = pd.DataFrame()

    # Bureau / credit features
    df["scDiasAtraso"] = rng.exponential(scale=15, size=n).clip(0, 180).astype(float)
    df["cdcScore"] = rng.normal(loc=600, scale=100, size=n).clip(300, 850).astype(float)
    df["carteraVencida"] = (
        rng.exponential(scale=5000, size=n).clip(0, 100000).astype(float)
    )

    # Employment / payroll
    df["imss_tenure_months"] = (
        rng.exponential(scale=24, size=n).clip(0, 180).astype(float)
    )
    df["monthly_salary"] = rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(7000, 60000)

    # Loan characteristics
    principal = rng.uniform(500, 8000, size=n)
    df["lti"] = (principal / df["monthly_salary"]).clip(0.01, 1.0)

    # Risk scores
    df["riskSeal_score"] = (
        rng.normal(loc=50, scale=20, size=n).clip(0, 100).astype(float)
    )
    df["employer_tier"] = rng.choice(
        [1, 2, 3, 4, 5], size=n, p=[0.1, 0.2, 0.4, 0.2, 0.1]
    ).astype(float)
    df["sector_risk"] = rng.choice(
        [1, 2, 3, 4, 5], size=n, p=[0.15, 0.25, 0.30, 0.20, 0.10]
    ).astype(float)
    df["afore_regularity"] = rng.beta(a=5, b=2, size=n).clip(0, 1)

    # Target: use strong non-linear thresholds so each feature
    # generates meaningful IV (WoE bins need clear good/bad separation)
    score = np.zeros(n)

    # scDiasAtraso: 0 days = great, >30 = bad
    score += 0.15 * (df["scDiasAtraso"] < 5).astype(float)
    score += 0.08 * ((df["scDiasAtraso"] >= 5) & (df["scDiasAtraso"] < 30)).astype(
        float
    )
    score -= 0.10 * (df["scDiasAtraso"] > 60).astype(float)

    # cdcScore: >700 = great, <450 = bad
    score += 0.15 * (df["cdcScore"] > 700).astype(float)
    score += 0.05 * ((df["cdcScore"] >= 500) & (df["cdcScore"] <= 700)).astype(float)
    score -= 0.10 * (df["cdcScore"] < 450).astype(float)

    # carteraVencida: 0 = great, >20k = bad
    score += 0.10 * (df["carteraVencida"] < 1000).astype(float)
    score -= 0.08 * (df["carteraVencida"] > 20000).astype(float)

    # imss_tenure: >24 = great, <6 = risky
    score += 0.12 * (df["imss_tenure_months"] > 24).astype(float)
    score -= 0.10 * (df["imss_tenure_months"] < 6).astype(float)

    # lti: <0.15 = safe, >0.35 = risky
    score += 0.10 * (df["lti"] < 0.15).astype(float)
    score -= 0.08 * (df["lti"] > 0.35).astype(float)

    # riskSeal_score: >65 = good, <30 = bad
    score += 0.08 * (df["riskSeal_score"] > 65).astype(float)
    score -= 0.06 * (df["riskSeal_score"] < 30).astype(float)

    # employer_tier: 1-2 = good, 4-5 = risky
    score += 0.08 * (df["employer_tier"] <= 2).astype(float)
    score -= 0.06 * (df["employer_tier"] >= 4).astype(float)

    # sector_risk: 1-2 = safe, 4-5 = risky
    score += 0.06 * (df["sector_risk"] <= 2).astype(float)
    score -= 0.05 * (df["sector_risk"] >= 4).astype(float)

    # afore_regularity: >0.8 = reliable
    score += 0.06 * (df["afore_regularity"] > 0.8).astype(float)
    score -= 0.04 * (df["afore_regularity"] < 0.4).astype(float)

    # monthly_salary: >20k = comfortable
    score += 0.06 * (df["monthly_salary"] > 20000).astype(float)
    score -= 0.04 * (df["monthly_salary"] < 10000).astype(float)

    # Hard rules
    score[df["imss_tenure_months"] < 3] -= 0.30
    score[df["scDiasAtraso"] > 90] -= 0.20

    noise = rng.normal(0, 0.08, size=n)
    prob = np.clip(score + noise + 0.50, 0, 1)  # center around 0.5
    df["target"] = (prob >= 0.50).astype(int)

    return df


def compute_woe_bins(
    df: pd.DataFrame, feature: str, target: str, n_bins: int = 5
) -> tuple[list[dict], float]:
    """
    Compute WoE bins and IV for a single feature.

    Uses equal-frequency binning (quantile-based) to create bins,
    then computes WoE and IV for each bin.

    Returns (bins_list, iv_total).
    """
    data = df[[feature, target]].copy()
    data = data.dropna()

    total_good = (data[target] == 1).sum()
    total_bad = (data[target] == 0).sum()

    if total_good == 0 or total_bad == 0:
        return [], 0.0

    # Create quantile bins
    try:
        data["bin"] = pd.qcut(data[feature], q=n_bins, duplicates="drop")
    except ValueError:
        data["bin"] = pd.cut(data[feature], bins=n_bins, duplicates="drop")

    bins_list = []
    iv_total = 0.0

    for bin_interval, group in data.groupby("bin", observed=True):
        good_count = (group[target] == 1).sum()
        bad_count = (group[target] == 0).sum()

        # Add smoothing to avoid division by zero
        good_pct = (good_count + 0.5) / (total_good + 1)
        bad_pct = (bad_count + 0.5) / (total_bad + 1)

        woe = float(np.log(good_pct / bad_pct))
        iv = float((good_pct - bad_pct) * woe)
        iv_total += iv

        bins_list.append(
            {
                "range": [float(bin_interval.left), float(bin_interval.right)],
                "woe": woe,
                "iv": iv,
                "count": len(group),
            }
        )

    return bins_list, iv_total


def train_and_save(output_path: str):
    df = generate_synthetic_data(N, rng)

    features = ScorecardChampion.FEATURE_SET
    target = "target"

    # Compute WoE bins and IV for all features
    woe_bins = {}
    iv_values = {}
    selected_features = []

    print("=" * 60)
    print("WoE Binning & IV Analysis")
    print("=" * 60)

    for feat in features:
        bins, iv = compute_woe_bins(df, feat, target)
        woe_bins[feat] = bins
        iv_values[feat] = iv
        status = "SELECTED" if iv >= IV_THRESHOLD else "dropped"
        print(f"  {feat:25s}  IV={iv:.4f}  [{status}]")
        if iv >= IV_THRESHOLD:
            selected_features.append(feat)

    if not selected_features:
        print("WARNING: No features passed IV threshold, using all features")
        selected_features = list(features)

    print(f"\nSelected {len(selected_features)} features with IV >= {IV_THRESHOLD}")

    # Transform features to WoE values
    # Transform through the SAME function the served model uses
    # (models/scorecard_model.lookup_woe). This loop used to be a second copy,
    # carrying the same out-of-range `bins[-1]` fallback that made a
    # below-floor value score as the safest band; keeping one implementation is
    # what stops a fix on the serving side from silently retraining the model
    # under different semantics. No row of this frame is out of range, so the
    # shipped artifact is unaffected — verified: 0 of 40,000 WoE values move.
    X_woe = np.zeros((len(df), len(selected_features)))
    for j, feat in enumerate(selected_features):
        for i in range(len(df)):
            X_woe[i, j] = lookup_woe(woe_bins[feat], df[feat].iloc[i])

    y = df[target].values

    # Train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        X_woe, y, test_size=0.2, random_state=SEED, stratify=y
    )

    # Train logistic regression
    lr = LogisticRegression(
        C=1.0, max_iter=1000, random_state=SEED, class_weight="balanced"
    )
    lr.fit(X_train, y_train)

    # Evaluate
    train_auc = roc_auc_score(y_train, lr.predict_proba(X_train)[:, 1])
    test_auc = roc_auc_score(y_test, lr.predict_proba(X_test)[:, 1])
    approval_rate = y.mean()

    print(f"\nApproval rate     : {approval_rate:.1%}")
    print(f"Train AUC         : {train_auc:.4f}")
    print(f"Test AUC          : {test_auc:.4f}")

    # Save model
    model = ScorecardChampion(
        woe_bins=woe_bins,
        iv_values=iv_values,
        lr_model=lr,
        selected_features=selected_features,
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model.save(output_path)
    print(f"Model saved to    : {output_path}")

    return model


if __name__ == "__main__":
    out = os.path.join(
        os.path.dirname(__file__), "..", "models", "scorecard_champion_v2.joblib"
    )
    train_and_save(os.path.abspath(out))
