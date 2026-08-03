"""
Generate synthetic baseline logistic regression model for loan underwriting.

Run once to produce models/underwriting_v1.joblib.

Synthetic data reflects VIDA's target borrower profile:
  - Mexican payroll workers earning 8k–40k MXN/month
  - Loans of 500–5000 MXN (30-day tenure, 30% monthly interest)
  - Approval rate target: ~65% for borrowers meeting minimum criteria

Usage: python scripts/train_baseline_model.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from models.underwriting_model import UnderwritingModel

SEED = 42
rng = np.random.default_rng(SEED)
N = 5000


def generate_synthetic_dataset(n: int, rng: np.random.Generator):
    """
    Produce synthetic training samples.

    Distributions are calibrated to VIDA's target customer:
    Mexican payroll workers, mostly 6-36 months tenure, 8k-30k salary.
    Label = 1 (repaid) based on credit rules + noise.
    """
    # Feature distributions matching VIDA's borrower population
    tenure = (
        rng.exponential(scale=18, size=n).clip(0, 120).astype(float)
    )  # mode ~0, mean ~18 mo
    salary = rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(
        7_000, 40_000
    )  # ~15k median
    pay_freq = rng.choice([1, 2, 4], size=n, p=[0.3, 0.5, 0.2]).astype(float)
    industry = rng.choice(range(9), size=n).astype(float)
    principal = rng.uniform(500, 5_000, size=n)
    lts_ratio = (principal / salary).clip(0.01, 0.99)
    bureau_score = rng.uniform(300, 800, size=n)
    has_bureau = rng.choice([0, 1], size=n, p=[0.45, 0.55]).astype(float)

    X = np.column_stack(
        [
            tenure,
            salary,
            pay_freq,
            lts_ratio,
            industry,
            principal,
            bureau_score,
            has_bureau,
        ]
    )

    # Repayment score — weighted sum of good features (all normalized to 0–1)
    score = (
        0.30 * np.clip(tenure / 36, 0, 1)  # 3 yrs is best
        + 0.20 * np.clip(salary / 25_000, 0, 1)  # 25k+ is best
        + 0.20 * np.clip(bureau_score / 800, 0, 1)
        + 0.15 * (1 - np.clip(lts_ratio / 0.30, 0, 1))  # low ratio is safe
        + 0.05 * has_bureau
        + 0.10 * (pay_freq / 4)  # weekly deduction is most reliable
    )
    # Hard rules
    score[tenure < 3] = 0.0
    score[lts_ratio > 0.50] *= 0.3

    noise = rng.normal(0, 0.08, size=n)
    prob_repay = np.clip(score + noise, 0, 1)
    y = (prob_repay >= 0.50).astype(int)

    return X, y


def train_and_save(output_path: str):
    X, y = generate_synthetic_dataset(N, rng)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    lr = LogisticRegression(
        C=1.0, max_iter=1000, random_state=SEED, class_weight="balanced"
    )
    lr.fit(X_scaled, y)

    approval_rate = y.mean()
    train_acc = lr.score(X_scaled, y)
    print(f"Synthetic approval rate : {approval_rate:.1%}")
    print(f"Training accuracy       : {train_acc:.1%}")
    print(f"Weights                 : {lr.coef_[0].round(4).tolist()}")
    print(f"Bias                    : {lr.intercept_[0]:.4f}")

    model = UnderwritingModel(
        weights=lr.coef_[0].tolist(),
        bias=float(lr.intercept_[0]),
        scaler=scaler,
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    model.save(output_path)
    print(f"Model saved to          : {output_path}")
    return model


if __name__ == "__main__":
    out = os.path.join(
        os.path.dirname(__file__), "..", "models", "underwriting_v1.joblib"
    )
    train_and_save(os.path.abspath(out))
