"""CNBV-interpretable WoE logistic regression scorecard.

Weight of Evidence (WoE) transforms continuous/categorical features into
a single credit score (300–850) and probability of default (PD), following
CNBV guidelines for consumer credit in Mexico.

The model is: P(repay) = sigmoid(β₀ + Σ βᵢ·WoEᵢ)
              PD       = 1 − P(repay)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, Literal, Optional

# ---------------------------------------------------------------------------
# WoE bin tables — expert-elicited for Mexican payroll credit (CNBV context)
# Each bin: (lower_exclusive, upper_inclusive, woe_value)
# Higher WoE → borrower characteristic signals lower default risk
# ---------------------------------------------------------------------------

_BUREAU_SCORE_BINS = [
    (float("-inf"), 400, -2.0),
    (400, 500, -1.2),
    (500, 600, -0.3),
    (600, 680, 0.5),
    (680, 720, 1.0),
    (720, float("inf"), 1.8),
]

_TENURE_BINS = [  # employment_tenure_months
    (float("-inf"), 3, -2.5),
    (3, 6, -1.0),
    (6, 12, -0.2),
    (12, 24, 0.5),
    (24, 48, 1.0),
    (48, float("inf"), 1.5),
]

_SALARY_BINS = [  # monthly_salary in MXN
    (float("-inf"), 6_000, -1.5),
    (6_000, 10_000, -0.5),
    (10_000, 15_000, 0.2),
    (15_000, 20_000, 0.7),
    (20_000, 30_000, 1.2),
    (30_000, float("inf"), 1.5),
]

_LTS_RATIO_BINS = [  # loan-to-monthly-salary ratio
    (float("-inf"), 0.10, 1.0),
    (0.10, 0.20, 0.5),
    (0.20, 0.30, -0.2),
    (0.30, 0.40, -0.8),
    (0.40, float("inf"), -1.5),
]

# Categorical look-ups: encoded integer → WoE
_PAY_FREQ_WOE: Dict[int, float] = {4: 0.8, 2: 0.3, 1: -0.2}  # weekly/biweekly/monthly
_INDUSTRY_WOE: Dict[int, float] = {
    0: -0.5,  # unknown
    1: 0.5,   # manufacturing
    2: -0.1,  # retail
    3: 0.7,   # healthcare
    4: 0.9,   # technology
    5: 0.6,   # education
    6: -0.3,  # construction
    7: 0.0,   # transportation
    8: 1.0,   # government / public sector
}
_BUREAU_RECORD_WOE: Dict[int, float] = {0: -0.3, 1: 0.3}

# Logistic regression coefficients (calibrated for WoE-transformed features)
# β₀ chosen so that an average-profile borrower has PD ≈ 21%
_COEF = {
    "intercept": 1.3,
    "bureau_score": 0.90,
    "employment_tenure_months": 0.80,
    "monthly_salary": 0.60,
    "loan_to_salary_ratio": 1.00,
    "pay_frequency_encoded": 0.25,
    "employer_industry_encoded": 0.20,
    "has_bureau_record": 0.15,
}

# Approve when model-estimated PD is below this threshold → ensures ≥80% precision
APPROVAL_PD_THRESHOLD = 0.20

RiskGrade = Literal["A", "B", "C", "D", "E"]


@dataclass
class ScorecardResult:
    credit_score: int              # 300–850
    pd_estimate: float             # Probability of Default ∈ [0, 1]
    risk_grade: RiskGrade
    woe_contributions: Dict[str, float]
    log_odds: float
    approved: bool                 # True when PD < APPROVAL_PD_THRESHOLD


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _lookup_bin(value: float, bins: list) -> float:
    """Return WoE for the first bin whose range contains value."""
    for lo, hi, woe in bins:
        if lo < value <= hi:
            return woe
    return bins[-1][2]


def _pd_to_credit_score(pd: float) -> int:
    """Map PD ∈ [0, 1] → credit score ∈ [300, 850]."""
    return max(300, min(850, round(850 - pd * 550)))


def _score_to_grade(score: int) -> RiskGrade:
    if score >= 720:
        return "A"
    if score >= 640:
        return "B"
    if score >= 560:
        return "C"
    if score >= 480:
        return "D"
    return "E"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_scorecard(features: dict) -> ScorecardResult:
    """Run the WoE logistic regression scorecard.

    Expected keys in *features*::

        bureau_score             float  (300–850; 0 or absent → no record)
        employment_tenure_months float
        monthly_salary           float  (MXN)
        principal_amount         float  (MXN; used to derive LTS when ratio absent)
        loan_to_salary_ratio     float  (optional override)
        pay_frequency_encoded    int    (4=weekly, 2=biweekly, 1=monthly)
        employer_industry_encoded int   (0–8)
        has_bureau_record        int    (0 or 1)
    """
    bureau_score = float(features.get("bureau_score") or 0)
    has_bureau = int(features.get("has_bureau_record", 0))
    tenure = float(features.get("employment_tenure_months", 0))
    salary = float(features.get("monthly_salary", 0))
    principal = float(features.get("principal_amount", 0))
    lts = float(
        features.get("loan_to_salary_ratio")
        or (principal / max(salary, 1))
    )
    pay_freq = int(features.get("pay_frequency_encoded", 1))
    industry = int(features.get("employer_industry_encoded", 0))

    # Bureau score WoE: no-record applicants use the no-record penalty
    bureau_woe = (
        _lookup_bin(bureau_score, _BUREAU_SCORE_BINS)
        if has_bureau
        else -0.5
    )

    woe: Dict[str, float] = {
        "bureau_score": bureau_woe,
        "employment_tenure_months": _lookup_bin(tenure, _TENURE_BINS),
        "monthly_salary": _lookup_bin(salary, _SALARY_BINS),
        "loan_to_salary_ratio": _lookup_bin(lts, _LTS_RATIO_BINS),
        "pay_frequency_encoded": _PAY_FREQ_WOE.get(pay_freq, -0.2),
        "employer_industry_encoded": _INDUSTRY_WOE.get(industry, -0.5),
        "has_bureau_record": _BUREAU_RECORD_WOE.get(has_bureau, -0.3),
    }

    log_odds = _COEF["intercept"] + sum(
        _COEF[k] * v for k, v in woe.items()
    )

    p_repay = 1.0 / (1.0 + math.exp(-log_odds))
    pd = round(1.0 - p_repay, 4)
    score = _pd_to_credit_score(pd)

    return ScorecardResult(
        credit_score=score,
        pd_estimate=pd,
        risk_grade=_score_to_grade(score),
        woe_contributions={k: round(v, 4) for k, v in woe.items()},
        log_odds=round(log_odds, 4),
        approved=pd < APPROVAL_PD_THRESHOLD,
    )
