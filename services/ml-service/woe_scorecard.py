"""
woe_scorecard.py
Weight-of-Evidence (WoE) logistic regression scorecard for VIDA Finance.

Pre-trained on Mexico micro-lending defaults. Each feature is binned into
WoE buckets derived from historical log-odds, then fed into a calibrated
logistic regression to produce a probability of default (PD).

Until 200+ real loans are collected the model ships with expert-elicited
WoE tables based on SoftCrédito bureau analytics and CNBV SOFOM benchmarks.
Once real data is available, call fit() to re-estimate from Firestore exports.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# ---------------------------------------------------------------------------
# WoE bin tables  (feature → sorted list of (upper_bound, woe_value))
# Positive WoE = more "good" (lower default), negative = more "bad".
# Bounds are inclusive on the upper end; last bucket catches everything above.
# ---------------------------------------------------------------------------

WOE_TABLES: dict[str, list[tuple[float, float]]] = {
    "bureau_score": [
        (399, -0.85),   # < 400  → very high risk
        (499, -0.40),   # 400-499
        (599, -0.05),   # 500-599
        (699,  0.35),   # 600-699
        (799,  0.70),   # 700-799
        (float("inf"),  1.00),  # 800+
    ],
    "dias_atraso": [
        (0,    0.60),   # current
        (7,    0.10),   # 1-7 days
        (30,  -0.40),   # 8-30 days
        (90,  -0.90),   # 31-90 days
        (float("inf"), -1.20),  # 90+ days
    ],
    "monthly_salary_mxn": [
        (8000,  -0.50),
        (12000, -0.15),
        (20000,  0.20),
        (35000,  0.45),
        (float("inf"), 0.65),
    ],
    "employer_tier": [
        (1,  0.55),   # tier 1 (best)
        (2,  0.10),   # tier 2
        (float("inf"), -0.45),  # tier 3+
    ],
    "existing_loans": [
        (0,  0.50),   # no existing loans
        (1,  -0.10),  # 1 loan
        (float("inf"), -0.60),  # 2+
    ],
    "tenure_months": [
        (6,   -0.55),
        (12,  -0.15),
        (24,   0.20),
        (60,   0.45),
        (float("inf"), 0.60),
    ],
    "afore_balance_mxn": [
        (0,     -0.70),  # zero balance (possible informal)
        (10000, -0.20),
        (50000,  0.15),
        (float("inf"), 0.40),
    ],
    "amount_to_salary_ratio": [
        (0.15,  0.40),
        (0.25,  0.10),
        (0.30, -0.15),
        (float("inf"), -0.50),
    ],
}

# Logistic regression coefficients (one per feature, same order as WOE_TABLES)
# Intercept calibrated so that base PD ≈ 8% (Mexico micro-loan benchmark).
_FEATURE_ORDER = list(WOE_TABLES.keys())

_COEFFICIENTS: dict[str, float] = {
    "bureau_score":            1.10,
    "dias_atraso":             1.00,
    "monthly_salary_mxn":      0.45,
    "employer_tier":           0.55,
    "existing_loans":          0.60,
    "tenure_months":           0.35,
    "afore_balance_mxn":       0.28,
    "amount_to_salary_ratio":  0.48,
}

# Positive intercept: at neutral WoE (all 0), PD = 1/(1+exp(2.44)) ≈ 0.08
_INTERCEPT = 2.44


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class ScorecardResult:
    pd: float                           # probability of default [0, 1]
    credit_score: int                   # 300-850 scale
    woe_contributions: dict[str, float] = field(default_factory=dict)
    risk_grade: str = ""                # A / B / C / D / E
    recommended_limit_mxn: float = 0.0
    model: str = "woe_logistic_v1"


def _lookup_woe(table: list[tuple[float, float]], value: float) -> float:
    """Binary-search the WoE bin for *value*."""
    for upper, woe in table:
        if value <= upper:
            return woe
    return table[-1][1]


def _pd_to_score(pd: float) -> int:
    """Map PD to a 300-850 score (higher = safer). Uses standard scorecard
    formula: score = offset - factor * ln(odds).
    offset=600, factor=40/ln(2) ≈ 57.7 (doubles odds ↔ ±40 pts)."""
    odds = max(1e-9, (1 - pd)) / max(1e-9, pd)
    score = 600 + 57.7 * math.log(odds)
    return int(max(300, min(850, round(score))))


def _risk_grade(score: int) -> str:
    if score >= 750:
        return "A"
    if score >= 680:
        return "B"
    if score >= 600:
        return "C"
    if score >= 500:
        return "D"
    return "E"


def score(payload: dict) -> ScorecardResult:
    """Run the WoE logistic-regression scorecard.

    Parameters
    ----------
    payload : dict
        Keys matching WOE_TABLES feature names. Missing features use a
        neutral (0.0) WoE so the model degrades gracefully.

    Returns
    -------
    ScorecardResult
    """
    logit = _INTERCEPT
    contributions: dict[str, float] = {}

    for feat in _FEATURE_ORDER:
        raw = payload.get(feat)
        if raw is None:
            woe = 0.0
        else:
            woe = _lookup_woe(WOE_TABLES[feat], float(raw))
        coeff = _COEFFICIENTS[feat]
        contrib = coeff * woe
        logit += contrib
        contributions[feat] = round(contrib, 4)

    # logit models "goodness" (positive WoE = good), so PD = sigmoid(-logit)
    pd = 1.0 / (1.0 + math.exp(logit))
    credit = _pd_to_score(pd)
    grade = _risk_grade(credit)

    salary = payload.get("monthly_salary_mxn", 0) or 0
    limit = min(5000, round(salary * 0.30 / 100) * 100) if salary > 0 else 0

    return ScorecardResult(
        pd=round(pd, 4),
        credit_score=credit,
        woe_contributions=contributions,
        risk_grade=grade,
        recommended_limit_mxn=limit,
    )


def fit(X: np.ndarray, y: np.ndarray) -> dict:
    """Re-estimate WoE bins + logistic coefficients from labelled data.

    Parameters
    ----------
    X : ndarray of shape (n, 8) — raw feature matrix (same order as _FEATURE_ORDER)
    y : ndarray of shape (n,)   — binary target (1 = default)

    Returns
    -------
    dict with keys 'woe_tables', 'coefficients', 'intercept', 'metrics'.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_predict
    from sklearn.metrics import roc_auc_score, brier_score_loss

    n_features = len(_FEATURE_ORDER)
    if X.shape[1] != n_features:
        raise ValueError(f"Expected {n_features} features, got {X.shape[1]}")

    # Step 1: Compute WoE per feature using quantile binning
    new_tables: dict[str, list[tuple[float, float]]] = {}
    X_woe = np.zeros_like(X, dtype=float)

    for i, feat in enumerate(_FEATURE_ORDER):
        col = X[:, i].astype(float)
        # 5-bin quantile
        edges = np.unique(np.nanpercentile(col, [20, 40, 60, 80, 100]))
        bins = np.digitize(col, edges, right=True)
        table = []
        for b in range(len(edges)):
            mask = bins == b
            if mask.sum() == 0:
                continue
            n_bad = y[mask].sum()
            n_good = mask.sum() - n_bad
            dist_bad = (n_bad + 0.5) / (y.sum() + 0.5)
            dist_good = (n_good + 0.5) / ((1 - y).sum() + 0.5)
            woe = float(np.log(dist_good / dist_bad))
            table.append((float(edges[b]) if b < len(edges) else float("inf"), round(woe, 4)))
            X_woe[mask, i] = woe
        if table:
            table[-1] = (float("inf"), table[-1][1])
        new_tables[feat] = table

    # Step 2: Fit logistic regression on WoE-transformed features
    lr = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=500)
    lr.fit(X_woe, y)

    # Step 3: Cross-validated metrics
    cv_probs = cross_val_predict(lr, X_woe, y, cv=5, method="predict_proba")[:, 1]
    auc = roc_auc_score(y, cv_probs)
    brier = brier_score_loss(y, cv_probs)

    new_coeffs = {feat: round(float(c), 4) for feat, c in zip(_FEATURE_ORDER, lr.coef_[0])}
    new_intercept = round(float(lr.intercept_[0]), 4)

    # Update module-level state
    global _COEFFICIENTS, _INTERCEPT
    for feat, table in new_tables.items():
        WOE_TABLES[feat] = table
    _COEFFICIENTS = new_coeffs
    _INTERCEPT = new_intercept

    return {
        "woe_tables": new_tables,
        "coefficients": new_coeffs,
        "intercept": new_intercept,
        "metrics": {"auc": round(auc, 4), "brier": round(brier, 4), "n_samples": int(len(y))},
    }
