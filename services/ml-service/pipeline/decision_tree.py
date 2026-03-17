"""VIDA Decision Tree — Stages 0–5 underwriting pipeline.

Stages
------
0  Pre-screening       Device blacklist / INFONAVIT channel routing
1  ISSSTE track        Government (ISSSTE) worker deduction-capacity check
2  IMSS/AFORE check    Formal-employment enrollment verification
3  KYC / Bureau gate   Identity verification + bureau fast-track
4  Behavioural fraud   Isolation Forest anomaly detection
5  AML + LLM Judge     Sanctions screening + WoE scorecard + Claude adjudication
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from .fraud_detector import run_fraud_detection, FRAUD_FLAG_THRESHOLD, FRAUD_REVIEW_THRESHOLD
from .woe_scorecard import run_scorecard, APPROVAL_PD_THRESHOLD
from .llm_judge import run_llm_judge

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

DecisionOutcome = Literal["approved", "rejected", "manual_review", "pending"]


@dataclass
class ApplicationInput:
    """Normalised input for the full underwriting pipeline."""

    # Identity
    applicant_id: str
    curp_hash: str = ""

    # Employment
    employment_type: str = "imss"       # infonavit | issste | imss | afore | informal
    employer_type: str = "private"      # public | private
    employment_tenure_months: int = 0
    monthly_salary: float = 0.0
    pay_frequency: str = "biweekly"     # weekly | biweekly | monthly
    imss_enrolled_months: int = 0
    has_afore: bool = False

    # Loan
    principal_amount: float = 0.0

    # KYC / Identity
    kyc_passed: bool = True
    kyc_confidence: float = 90.0       # 0–100

    # Bureau
    bureau_score: Optional[float] = None
    bureau_inquiry_count: int = 0
    has_bureau_record: bool = False

    # Fraud signals
    device_fingerprint: str = ""
    device_age_days: int = 365
    requests_last_hour: int = 0
    geo_distance_km: float = 0.0
    same_ip_applications: int = 0
    time_since_last_app_hours: float = 720.0
    blacklisted_device: bool = False

    # AML
    aml_clear: bool = True             # True when sanctions list returns clean
    pep_flag: bool = False             # Politically Exposed Person

    # Employer metadata
    employer_industry: str = ""
    employer_size: str = "51-200"

    # Encoded fields (populated automatically if absent)
    pay_frequency_encoded: Optional[int] = None
    employer_industry_encoded: Optional[int] = None


@dataclass
class StageResult:
    stage: int
    name: str
    passed: bool
    outcome: DecisionOutcome
    rejection_reason: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PipelineResult:
    """Output from the full underwriting pipeline."""

    applicant_id: str
    decision: DecisionOutcome
    stage_reached: int
    stage_name: str

    # Scores
    fraud_score: float = 0.0
    credit_score: int = 300
    pd_estimate: float = 1.0
    risk_grade: str = "E"

    # Routing
    stage_results: List[StageResult] = field(default_factory=list)
    rejection_reason: Optional[str] = None
    approval_conditions: List[str] = field(default_factory=list)

    # Attribution
    models_used: List[str] = field(default_factory=list)
    processing_time_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# Pay-frequency and industry encoders (shared with worker)
# ---------------------------------------------------------------------------

_PAY_FREQ_MAP = {"weekly": 4, "biweekly": 2, "monthly": 1}
_INDUSTRY_MAP = {
    "manufacturing": 1, "retail": 2, "healthcare": 3,
    "technology": 4, "education": 5, "construction": 6,
    "transportation": 7, "government": 8, "public": 8,
}

MINIMUM_SALARY_MXN = 5_000      # hard floor: MXN 5 000/month
ISSSTE_MAX_DEDUCTION_RATIO = 0.30  # ISSSTE deduction cannot exceed 30% of salary
IMSS_MIN_ENROLLED_MONTHS = 6    # formal employment stability gate
BUREAU_AUTO_APPROVE_SCORE = 720  # bureau score for fast-track approval
KYC_MIN_CONFIDENCE = 70.0       # minimum KYC confidence to proceed


# ---------------------------------------------------------------------------
# Stage functions
# ---------------------------------------------------------------------------

def _stage0_prescreening(app: ApplicationInput) -> StageResult:
    """Device blacklist check and employment channel routing."""
    if app.blacklisted_device:
        return StageResult(
            stage=0,
            name="pre_screening",
            passed=False,
            outcome="rejected",
            rejection_reason="Device fingerprint is blacklisted",
            details={"device_fingerprint": app.device_fingerprint},
        )

    if app.employment_type == "informal":
        return StageResult(
            stage=0,
            name="pre_screening",
            passed=False,
            outcome="rejected",
            rejection_reason="Informal employment not eligible; formal payroll required",
        )

    return StageResult(
        stage=0,
        name="pre_screening",
        passed=True,
        outcome="pending",
        details={
            "employment_type": app.employment_type,
            "route": (
                "issste_track" if app.employment_type == "issste"
                else "standard_track"
            ),
        },
    )


def _stage1_issste(app: ApplicationInput) -> StageResult:
    """ISSSTE government workers: deduction capacity check."""
    if app.monthly_salary < MINIMUM_SALARY_MXN:
        return StageResult(
            stage=1,
            name="issste_check",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"Monthly salary MXN {app.monthly_salary:,.0f} below minimum "
                f"MXN {MINIMUM_SALARY_MXN:,}"
            ),
        )

    deduction_ratio = app.principal_amount / max(app.monthly_salary, 1)
    if deduction_ratio > ISSSTE_MAX_DEDUCTION_RATIO:
        return StageResult(
            stage=1,
            name="issste_check",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"Deduction ratio {deduction_ratio:.1%} exceeds ISSSTE cap "
                f"of {ISSSTE_MAX_DEDUCTION_RATIO:.0%}"
            ),
            details={"deduction_ratio": round(deduction_ratio, 3)},
        )

    return StageResult(
        stage=1,
        name="issste_check",
        passed=True,
        outcome="pending",
        details={"deduction_ratio": round(deduction_ratio, 3)},
    )


def _stage2_imss_afore(app: ApplicationInput) -> StageResult:
    """IMSS enrollment and AFORE stability gate for private-sector workers."""
    if app.imss_enrolled_months < IMSS_MIN_ENROLLED_MONTHS and not app.has_afore:
        return StageResult(
            stage=2,
            name="imss_afore_check",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"IMSS enrollment {app.imss_enrolled_months} months < "
                f"{IMSS_MIN_ENROLLED_MONTHS} months required and no AFORE found"
            ),
            details={
                "imss_enrolled_months": app.imss_enrolled_months,
                "has_afore": app.has_afore,
            },
        )

    return StageResult(
        stage=2,
        name="imss_afore_check",
        passed=True,
        outcome="pending",
        details={
            "imss_enrolled_months": app.imss_enrolled_months,
            "has_afore": app.has_afore,
        },
    )


def _stage3_kyc_bureau(app: ApplicationInput) -> StageResult:
    """KYC identity verification + bureau fast-track gate."""
    if not app.kyc_passed or app.kyc_confidence < KYC_MIN_CONFIDENCE:
        return StageResult(
            stage=3,
            name="kyc_bureau_gate",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"KYC failed (passed={app.kyc_passed}, "
                f"confidence={app.kyc_confidence:.0f}%)"
            ),
            details={"kyc_confidence": app.kyc_confidence},
        )

    # Bureau fast-track: excellent credit history skips fraud stage
    if (
        app.has_bureau_record
        and app.bureau_score is not None
        and app.bureau_score >= BUREAU_AUTO_APPROVE_SCORE
    ):
        return StageResult(
            stage=3,
            name="kyc_bureau_gate",
            passed=True,
            outcome="approved",  # fast-track approval
            details={
                "bureau_score": app.bureau_score,
                "fast_track": True,
            },
        )

    return StageResult(
        stage=3,
        name="kyc_bureau_gate",
        passed=True,
        outcome="pending",
        details={
            "kyc_confidence": app.kyc_confidence,
            "bureau_score": app.bureau_score,
            "fast_track": False,
        },
    )


def _stage4_fraud(app: ApplicationInput) -> StageResult:
    """Isolation Forest behavioural anomaly detection."""
    lts = app.principal_amount / max(app.monthly_salary, 1)
    signals = {
        "requests_last_hour": app.requests_last_hour,
        "amount_to_salary_ratio": lts,
        "device_age_days": app.device_age_days,
        "geo_distance_km": app.geo_distance_km,
        "same_ip_applications": app.same_ip_applications,
        "time_since_last_app_hours": app.time_since_last_app_hours,
        "kyc_confidence_score": app.kyc_confidence,
        "bureau_inquiry_count": app.bureau_inquiry_count,
    }
    fraud = run_fraud_detection(signals)

    if fraud.is_fraud:
        return StageResult(
            stage=4,
            name="fraud_detection",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"Fraud score {fraud.fraud_score:.0f}/100 exceeds threshold. "
                + (f"Flags: {'; '.join(fraud.hard_flags)}" if fraud.hard_flags else "")
            ),
            details={"fraud_result": fraud.__dict__},
        )

    # Borderline fraud (needs_review) continues to Stage 5 for LLM adjudication
    return StageResult(
        stage=4,
        name="fraud_detection",
        passed=True,
        outcome="pending",
        details={
            "fraud_score": fraud.fraud_score,
            "needs_review": fraud.needs_review,
            "contributions": fraud.anomaly_contributions,
        },
    )


def _stage5_aml_llm(
    app: ApplicationInput,
    fraud_score: float,
    anthropic_api_key: Optional[str] = None,
) -> StageResult:
    """AML/Sanctions screening, WoE scorecard, and Claude LLM Judge."""
    # AML checks
    if not app.aml_clear:
        return StageResult(
            stage=5,
            name="aml_llm_judge",
            passed=False,
            outcome="rejected",
            rejection_reason="AML / sanctions list match",
        )

    if app.pep_flag:
        return StageResult(
            stage=5,
            name="aml_llm_judge",
            passed=False,
            outcome="manual_review",
            rejection_reason="Politically Exposed Person — manual underwriter review required",
        )

    # Encode features for scorecard
    pay_enc = (
        app.pay_frequency_encoded
        if app.pay_frequency_encoded is not None
        else _PAY_FREQ_MAP.get(app.pay_frequency, 1)
    )
    industry_enc = (
        app.employer_industry_encoded
        if app.employer_industry_encoded is not None
        else _INDUSTRY_MAP.get(app.employer_industry.lower(), 0)
    )

    features = {
        "bureau_score": app.bureau_score or 0,
        "employment_tenure_months": app.employment_tenure_months,
        "monthly_salary": app.monthly_salary,
        "principal_amount": app.principal_amount,
        "pay_frequency_encoded": pay_enc,
        "employer_industry_encoded": industry_enc,
        "has_bureau_record": int(app.has_bureau_record),
    }
    scorecard = run_scorecard(features)

    # Hard-approve and hard-reject bands
    if scorecard.pd_estimate < 0.10:
        # Very low risk: approve directly without LLM
        return StageResult(
            stage=5,
            name="aml_llm_judge",
            passed=True,
            outcome="approved",
            details={
                "scorecard": scorecard.__dict__,
                "llm_used": False,
                "direct_approval": True,
            },
        )

    if scorecard.pd_estimate > 0.35:
        return StageResult(
            stage=5,
            name="aml_llm_judge",
            passed=False,
            outcome="rejected",
            rejection_reason=(
                f"Credit score {scorecard.credit_score} / PD "
                f"{scorecard.pd_estimate:.1%} exceeds maximum risk threshold"
            ),
            details={"scorecard": scorecard.__dict__, "llm_used": False},
        )

    # Borderline zone (PD 10%–35%): Claude LLM-as-Judge
    judge = run_llm_judge(
        monthly_salary=app.monthly_salary,
        principal_amount=app.principal_amount,
        tenure_months=app.employment_tenure_months,
        employment_type=app.employment_type,
        pd_estimate=scorecard.pd_estimate,
        credit_score=scorecard.credit_score,
        risk_grade=scorecard.risk_grade,
        fraud_score=fraud_score,
        kyc_confidence=app.kyc_confidence,
        bureau_record=app.has_bureau_record,
        bureau_score=app.bureau_score,
        aml_clear=app.aml_clear,
        stage_reached=5,
        anthropic_api_key=anthropic_api_key,
    )

    outcome: DecisionOutcome = judge.decision  # type: ignore[assignment]
    rejection_reason = None
    if outcome == "rejected":
        rejection_reason = judge.reasoning

    return StageResult(
        stage=5,
        name="aml_llm_judge",
        passed=outcome != "rejected",
        outcome=outcome,
        rejection_reason=rejection_reason,
        details={
            "scorecard": scorecard.__dict__,
            "llm_judge": judge.__dict__,
            "llm_used": not judge.used_fallback,
        },
    )


# ---------------------------------------------------------------------------
# Full pipeline orchestrator
# ---------------------------------------------------------------------------

def run_pipeline(
    app: ApplicationInput,
    anthropic_api_key: Optional[str] = None,
) -> PipelineResult:
    """Execute the full 6-stage underwriting decision tree.

    Returns a PipelineResult containing the final decision, credit score,
    fraud score, and the result from every stage that was executed.
    """
    t0 = time.perf_counter()

    result = PipelineResult(applicant_id=app.applicant_id, decision="pending", stage_reached=0, stage_name="")
    fraud_score_value: float = 0.0

    # ── Stage 0: Pre-screening ─────────────────────────────────────────────
    s0 = _stage0_prescreening(app)
    result.stage_results.append(s0)
    result.stage_reached = 0
    result.stage_name = s0.name
    if not s0.passed:
        result.decision = s0.outcome
        result.rejection_reason = s0.rejection_reason
        result.models_used = ["rule_based"]
        result.processing_time_ms = (time.perf_counter() - t0) * 1000
        return result

    # ── Stage routing: ISSSTE vs standard ──────────────────────────────────
    if app.employment_type == "issste":
        s1 = _stage1_issste(app)
        result.stage_results.append(s1)
        result.stage_reached = 1
        result.stage_name = s1.name
        if not s1.passed:
            result.decision = s1.outcome
            result.rejection_reason = s1.rejection_reason
            result.models_used = ["rule_based"]
            result.processing_time_ms = (time.perf_counter() - t0) * 1000
            return result
    elif app.employment_type in ("imss", "afore", "infonavit"):
        s2 = _stage2_imss_afore(app)
        result.stage_results.append(s2)
        result.stage_reached = 2
        result.stage_name = s2.name
        if not s2.passed:
            result.decision = s2.outcome
            result.rejection_reason = s2.rejection_reason
            result.models_used = ["rule_based"]
            result.processing_time_ms = (time.perf_counter() - t0) * 1000
            return result

    # ── Stage 3: KYC / Bureau gate ─────────────────────────────────────────
    s3 = _stage3_kyc_bureau(app)
    result.stage_results.append(s3)
    result.stage_reached = 3
    result.stage_name = s3.name
    if not s3.passed:
        result.decision = s3.outcome
        result.rejection_reason = s3.rejection_reason
        result.models_used = ["rule_based"]
        result.processing_time_ms = (time.perf_counter() - t0) * 1000
        return result
    if s3.outcome == "approved":
        # Bureau fast-track: compute scorecard for credit score but skip fraud
        pay_enc = (
            app.pay_frequency_encoded
            if app.pay_frequency_encoded is not None
            else _PAY_FREQ_MAP.get(app.pay_frequency, 1)
        )
        industry_enc = (
            app.employer_industry_encoded
            if app.employer_industry_encoded is not None
            else _INDUSTRY_MAP.get(app.employer_industry.lower(), 0)
        )
        sc = run_scorecard({
            "bureau_score": app.bureau_score or 0,
            "employment_tenure_months": app.employment_tenure_months,
            "monthly_salary": app.monthly_salary,
            "principal_amount": app.principal_amount,
            "pay_frequency_encoded": pay_enc,
            "employer_industry_encoded": industry_enc,
            "has_bureau_record": int(app.has_bureau_record),
        })
        result.decision = "approved"
        result.credit_score = sc.credit_score
        result.pd_estimate = sc.pd_estimate
        result.risk_grade = sc.risk_grade
        result.fraud_score = 0.0
        result.models_used = ["rule_based", "woe_scorecard"]
        result.processing_time_ms = (time.perf_counter() - t0) * 1000
        return result

    # ── Stage 4: Fraud detection ───────────────────────────────────────────
    s4 = _stage4_fraud(app)
    result.stage_results.append(s4)
    result.stage_reached = 4
    result.stage_name = s4.name
    fraud_score_value = s4.details.get("fraud_result", {}).get("fraud_score", 0) or s4.details.get("fraud_score", 0)
    result.fraud_score = fraud_score_value

    if not s4.passed:
        result.decision = s4.outcome
        result.rejection_reason = s4.rejection_reason
        result.models_used = ["rule_based", "isolation_forest"]
        result.processing_time_ms = (time.perf_counter() - t0) * 1000
        return result

    # ── Stage 5: AML / WoE scorecard / LLM Judge ──────────────────────────
    s5 = _stage5_aml_llm(app, fraud_score_value, anthropic_api_key)
    result.stage_results.append(s5)
    result.stage_reached = 5
    result.stage_name = s5.name

    scorecard_data = s5.details.get("scorecard", {})
    if scorecard_data:
        result.credit_score = scorecard_data.get("credit_score", 300)
        result.pd_estimate = scorecard_data.get("pd_estimate", 1.0)
        result.risk_grade = scorecard_data.get("risk_grade", "E")

    result.decision = s5.outcome
    result.rejection_reason = s5.rejection_reason

    models = ["rule_based", "isolation_forest", "woe_scorecard"]
    if s5.details.get("llm_used"):
        models.append("claude_llm_judge")
    result.models_used = models
    result.processing_time_ms = round((time.perf_counter() - t0) * 1000, 2)
    return result
