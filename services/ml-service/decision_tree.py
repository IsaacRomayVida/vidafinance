"""
decision_tree.py
VIDA Finance ML Underwriting Engine v1 — Decision Tree Stages 0-5.

Orchestrates the full underwriting pipeline. Each stage can:
  - PASS  → advance to next stage
  - FLAG  → record concern, continue to next stage
  - REJECT → hard stop, application denied

Stage 0: Device Fingerprint & INFONAVIT (net disposable income)
Stage 1: Government Worker Verification (ISSSTE parallel to IMSS)
Stage 2: Employment & Income Verification (IMSS, AFORE, payroll OCR)
Stage 3: KYC + Bureau Auto-Approve Gate (Incode + SoftCrédito)
Stage 4: Behavioral Fraud + Bank Transactions (Sardine + Belvo + Isolation Forest)
Stage 5: AML/Sanctions + LLM Judge (Truora + Claude adjudication)

The engine is designed to be called from the /underwrite/pipeline endpoint.
Each stage receives accumulated context and returns a StageResult.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from enum import Enum

from woe_scorecard import score as woe_score, ScorecardResult
from fraud_detector import detect as fraud_detect, FraudResult
from llm_judge import judge as llm_judge, JudgeResult


class StageOutcome(str, Enum):
    PASS = "pass"
    FLAG = "flag"
    REJECT = "reject"


@dataclass
class StageResult:
    stage: int
    outcome: StageOutcome
    reason: str = ""
    data: dict = field(default_factory=dict)
    latency_ms: int = 0


@dataclass
class PipelineResult:
    application_id: str
    final_decision: str          # approved | conditionally_approved | rejected | manual_review
    final_stage: int             # last stage reached
    credit_score: int = 0
    recommended_limit_mxn: float = 0.0
    pd: float = 0.0
    risk_grade: str = ""
    scorecard: dict = field(default_factory=dict)
    fraud: dict = field(default_factory=dict)
    llm_judge: dict = field(default_factory=dict)
    stage_results: list = field(default_factory=list)
    flags: list = field(default_factory=list)
    total_latency_ms: int = 0
    model_version: str = "decision_tree_v1"
    ts: int = 0


# ---------------------------------------------------------------------------
# Stage implementations
# ---------------------------------------------------------------------------

def _stage_0(ctx: dict) -> StageResult:
    """Stage 0: Device Fingerprint & INFONAVIT check.

    Checks device fraud signals and computes net disposable income
    after INFONAVIT housing loan deductions.
    """
    start = time.time()
    device_risk = ctx.get("device_risk_score", 0)
    infonavit_deduction = ctx.get("infonavit_monthly_deduction", 0)
    salary = ctx.get("monthly_salary_mxn", 0)

    # Net disposable after INFONAVIT
    net_disposable = max(0, salary - infonavit_deduction)
    ctx["net_disposable_mxn"] = net_disposable

    data = {
        "device_risk_score": device_risk,
        "infonavit_deduction": infonavit_deduction,
        "net_disposable_mxn": net_disposable,
    }

    # Hard reject: extreme device fraud
    if device_risk >= 90:
        return StageResult(0, StageOutcome.REJECT, "device_fraud_extreme", data,
                           int((time.time() - start) * 1000))

    # Flag: elevated device risk
    if device_risk >= 60:
        return StageResult(0, StageOutcome.FLAG, "device_risk_elevated", data,
                           int((time.time() - start) * 1000))

    # Flag: INFONAVIT eats most of salary
    if salary > 0 and infonavit_deduction / salary > 0.30:
        return StageResult(0, StageOutcome.FLAG, "high_infonavit_burden", data,
                           int((time.time() - start) * 1000))

    return StageResult(0, StageOutcome.PASS, "ok", data,
                       int((time.time() - start) * 1000))


def _stage_1(ctx: dict) -> StageResult:
    """Stage 1: Government Worker Verification (ISSSTE).

    For government employers, verifies ISSSTE employment records.
    Non-government employers skip with PASS.
    """
    start = time.time()
    is_gov = ctx.get("is_government_employer", False)

    if not is_gov:
        return StageResult(1, StageOutcome.PASS, "non_government_skip", {},
                           int((time.time() - start) * 1000))

    issste_active = ctx.get("issste_active", False)
    issste_salary = ctx.get("issste_salary_sbc", 0)

    data = {"issste_active": issste_active, "issste_salary_sbc": issste_salary}

    if not issste_active:
        return StageResult(1, StageOutcome.REJECT, "issste_not_active", data,
                           int((time.time() - start) * 1000))

    # Cross-check salary: ISSSTE SBC vs declared salary (allow 20% variance)
    declared = ctx.get("monthly_salary_mxn", 0)
    if declared > 0 and issste_salary > 0:
        ratio = abs(issste_salary - declared) / declared
        if ratio > 0.20:
            data["salary_variance"] = round(ratio, 3)
            return StageResult(1, StageOutcome.FLAG, "salary_mismatch_issste", data,
                               int((time.time() - start) * 1000))

    return StageResult(1, StageOutcome.PASS, "ok", data,
                       int((time.time() - start) * 1000))


def _stage_2(ctx: dict) -> StageResult:
    """Stage 2: Employment & Income Verification (IMSS, AFORE).

    Verifies IMSS employment records, checks AFORE contribution
    regularity, and cross-validates salary declarations.
    """
    start = time.time()
    imss_active = ctx.get("imss_active", True)
    imss_salary_sbc = ctx.get("imss_salary_sbc", 0)
    afore_balance = ctx.get("afore_balance_mxn", 0)
    tenure_months = ctx.get("tenure_months", 0)
    declared_salary = ctx.get("monthly_salary_mxn", 0)

    data = {
        "imss_active": imss_active,
        "imss_salary_sbc": imss_salary_sbc,
        "afore_balance": afore_balance,
        "tenure_months": tenure_months,
    }

    # Hard reject: not registered with IMSS
    if not imss_active:
        return StageResult(2, StageOutcome.REJECT, "imss_not_active", data,
                           int((time.time() - start) * 1000))

    flags = []

    # Salary cross-check
    if declared_salary > 0 and imss_salary_sbc > 0:
        ratio = abs(imss_salary_sbc - declared_salary) / declared_salary
        if ratio > 0.25:
            flags.append("salary_mismatch_imss")
            data["salary_variance"] = round(ratio, 3)

    # Zero AFORE = possible informal employment
    if afore_balance <= 0:
        flags.append("zero_afore_balance")

    # Very short tenure
    if tenure_months < 3:
        flags.append("short_tenure")

    if flags:
        return StageResult(2, StageOutcome.FLAG, "|".join(flags), data,
                           int((time.time() - start) * 1000))

    return StageResult(2, StageOutcome.PASS, "ok", data,
                       int((time.time() - start) * 1000))


def _stage_3(ctx: dict) -> StageResult:
    """Stage 3: KYC + Bureau Auto-Approve Gate.

    Bureau score >= 600 + clean history → auto-approve.
    Score 400-599 or minor late → flag, continue to Stage 4.
    Score < 400 or severe delinquency → escalate to Stage 5.
    """
    start = time.time()
    bureau_score = ctx.get("bureau_score")
    dias_atraso = ctx.get("dias_atraso", 0)
    cartera_vencida = ctx.get("cartera_vencida", False)
    kyc_pass = ctx.get("kyc_verified", True)
    pld_blocked = ctx.get("pld_bloqueo_lista_sat", False)

    data = {
        "bureau_score": bureau_score,
        "dias_atraso": dias_atraso,
        "cartera_vencida": cartera_vencida,
        "kyc_verified": kyc_pass,
        "pld_blocked": pld_blocked,
    }

    # KYC failure
    if not kyc_pass:
        return StageResult(3, StageOutcome.REJECT, "kyc_failed", data,
                           int((time.time() - start) * 1000))

    # PLD blacklist → immediate Stage 5 escalation
    if pld_blocked:
        return StageResult(3, StageOutcome.REJECT, "pld_sat_blacklist", data,
                           int((time.time() - start) * 1000))

    # Active default → Stage 5
    if cartera_vencida:
        return StageResult(3, StageOutcome.REJECT, "active_default", data,
                           int((time.time() - start) * 1000))

    # Days late >= 31 → Stage 5
    if dias_atraso >= 31:
        return StageResult(3, StageOutcome.REJECT, "days_late_31_plus", data,
                           int((time.time() - start) * 1000))

    # Score < 400 → Stage 5
    if bureau_score is not None and bureau_score < 400:
        return StageResult(3, StageOutcome.REJECT, "score_below_400", data,
                           int((time.time() - start) * 1000))

    # Score 400-599 or days late 1-30 → Flag (continue to Stage 4)
    if dias_atraso >= 1:
        return StageResult(3, StageOutcome.FLAG, "days_late_1_30", data,
                           int((time.time() - start) * 1000))

    if bureau_score is not None and bureau_score < 600:
        return StageResult(3, StageOutcome.FLAG, "score_400_599", data,
                           int((time.time() - start) * 1000))

    # Score >= 600 + clean → PASS (auto-approve gate)
    return StageResult(3, StageOutcome.PASS, "auto_approve_eligible", data,
                       int((time.time() - start) * 1000))


def _stage_4(ctx: dict) -> StageResult:
    """Stage 4: Behavioral Fraud + Bank Transactions + Isolation Forest.

    Runs the Isolation Forest fraud detector and evaluates behavioral
    biometrics from Sardine. Bank transaction analysis for cash-flow.
    """
    start = time.time()

    # Run Isolation Forest fraud detection
    fraud_payload = {
        "requests_last_hour": ctx.get("requests_last_hour", 0),
        "amount_to_salary_ratio": ctx.get("amount_to_salary_ratio", 0),
        "device_risk_score": ctx.get("device_risk_score", 0),
        "behavioral_risk_score": ctx.get("behavioral_risk_score", 0),
        "hour_of_day": ctx.get("hour_of_day", 14),
        "days_since_account_created": ctx.get("days_since_account_created", 90),
        "ip_country_mismatch": 1 if ctx.get("ip_country_mismatch") else 0,
        "bureau_inquiries_90d": ctx.get("bureau_inquiries_90d", 0),
    }
    fraud_result = fraud_detect(fraud_payload)
    ctx["_fraud_result"] = asdict(fraud_result)

    # Sardine behavioral result (passed in from underwriting-service)
    sardine_pass = ctx.get("sardine_pass", True)
    sardine_risk = ctx.get("sardine_risk_level", "low")

    # Bank transaction signals
    bank_avg_balance = ctx.get("bank_avg_balance_90d", 0)
    bank_overdrafts = ctx.get("bank_overdraft_count_90d", 0)

    data = {
        "fraud_anomaly_score": fraud_result.anomaly_score,
        "fraud_is_fraud": fraud_result.is_fraud,
        "fraud_hard_flags": fraud_result.hard_flags,
        "sardine_risk_level": sardine_risk,
        "sardine_pass": sardine_pass,
        "bank_avg_balance": bank_avg_balance,
        "bank_overdrafts": bank_overdrafts,
    }

    # Hard reject: confirmed fraud
    if fraud_result.is_fraud and len(fraud_result.hard_flags) >= 2:
        return StageResult(4, StageOutcome.REJECT, "multi_fraud_flags", data,
                           int((time.time() - start) * 1000))

    # Hard reject: Sardine bot detection
    if sardine_risk in ("very_high",) and not sardine_pass:
        return StageResult(4, StageOutcome.REJECT, "bot_detected", data,
                           int((time.time() - start) * 1000))

    flags = []
    if fraud_result.is_fraud:
        flags.append("fraud_anomaly_detected")
    if not sardine_pass:
        flags.append("sardine_risk_high")
    if bank_overdrafts >= 3:
        flags.append("frequent_overdrafts")

    if flags:
        return StageResult(4, StageOutcome.FLAG, "|".join(flags), data,
                           int((time.time() - start) * 1000))

    return StageResult(4, StageOutcome.PASS, "ok", data,
                       int((time.time() - start) * 1000))


def _stage_5(ctx: dict, evidence: dict) -> StageResult:
    """Stage 5: AML/Sanctions + LLM-as-Judge.

    Final adjudication for escalated applications. Runs Truora AML
    checks and Claude LLM Judge for complex decisions.
    """
    start = time.time()

    # AML signals (from Truora via underwriting-service)
    aml_criminal = ctx.get("aml_criminal_records", None)
    aml_pep = ctx.get("aml_pep_match", False)
    aml_sanctions = ctx.get("aml_sanctions_match", False)

    # Hard reject: confirmed criminal/sanctions
    if aml_criminal and aml_criminal != "None":
        return StageResult(5, StageOutcome.REJECT, "criminal_records", {
            "aml_criminal": aml_criminal, "aml_pep": aml_pep, "aml_sanctions": aml_sanctions,
        }, int((time.time() - start) * 1000))

    if aml_sanctions:
        return StageResult(5, StageOutcome.REJECT, "sanctions_match", {
            "aml_sanctions": True,
        }, int((time.time() - start) * 1000))

    # Run LLM Judge
    judge_result = llm_judge(evidence)
    ctx["_llm_judge_result"] = asdict(judge_result)

    data = {
        "llm_decision": judge_result.decision,
        "llm_confidence": judge_result.confidence,
        "llm_reasoning": judge_result.reasoning,
        "aml_pep": aml_pep,
        "aml_sanctions": aml_sanctions,
    }

    if judge_result.decision == "REJECT":
        return StageResult(5, StageOutcome.REJECT, "llm_judge_reject", data,
                           int((time.time() - start) * 1000))

    if judge_result.decision == "ESCALATE_TO_HUMAN":
        return StageResult(5, StageOutcome.FLAG, "llm_judge_escalate", data,
                           int((time.time() - start) * 1000))

    # APPROVE_WITH_CONDITIONS
    return StageResult(5, StageOutcome.PASS, "llm_judge_conditional_approve", data,
                       int((time.time() - start) * 1000))


# ---------------------------------------------------------------------------
# Pipeline orchestrator
# ---------------------------------------------------------------------------

STAGES = [_stage_0, _stage_1, _stage_2, _stage_3, _stage_4]
# Stage 5 has a different signature (needs accumulated evidence)


def run_pipeline(payload: dict) -> PipelineResult:
    """Execute the full Decision Tree pipeline (Stages 0-5).

    Parameters
    ----------
    payload : dict
        All application data. Keys are consumed by individual stages.
        Required: monthly_salary_mxn, bureau_score, employer_tier.

    Returns
    -------
    PipelineResult with final decision and all stage outcomes.
    """
    pipeline_start = time.time()
    app_id = payload.get("application_id", f"app_{int(time.time())}")
    ctx = dict(payload)  # mutable copy

    stage_results: list[dict] = []
    flags: list[str] = []
    reached_stage = -1
    rejected = False
    reject_stage = -1

    # Run Stages 0-4
    for stage_fn in STAGES:
        result = stage_fn(ctx)
        reached_stage = result.stage
        sr_dict = {
            "stage": result.stage,
            "outcome": result.outcome.value,
            "reason": result.reason,
            "data": result.data,
            "latency_ms": result.latency_ms,
            "pass": result.outcome != StageOutcome.REJECT,
        }
        stage_results.append(sr_dict)

        if result.outcome == StageOutcome.FLAG:
            flags.append(f"stage_{result.stage}:{result.reason}")

        if result.outcome == StageOutcome.REJECT:
            rejected = True
            reject_stage = result.stage
            break

    # Run WoE scorecard regardless (for scoring data)
    scorecard_payload = {
        "bureau_score": ctx.get("bureau_score", 500),
        "dias_atraso": ctx.get("dias_atraso", 0),
        "monthly_salary_mxn": ctx.get("monthly_salary_mxn", 0),
        "employer_tier": ctx.get("employer_tier", 2),
        "existing_loans": ctx.get("existing_loans", 0),
        "tenure_months": ctx.get("tenure_months", 0),
        "afore_balance_mxn": ctx.get("afore_balance_mxn", 0),
        "amount_to_salary_ratio": ctx.get("amount_to_salary_ratio", 0),
    }
    sc_result = woe_score(scorecard_payload)
    scorecard_dict = asdict(sc_result)

    # Determine if Stage 5 is needed
    needs_stage_5 = False
    llm_judge_dict: dict = {}

    if rejected and reject_stage == 3:
        # Stage 3 rejects (bureau/PLD) escalate to Stage 5 for final adjudication
        needs_stage_5 = True
    elif not rejected and len(flags) > 0:
        # Flagged applications go to Stage 5
        needs_stage_5 = True
    elif rejected and reject_stage == 4:
        # Stage 4 fraud rejects also get Stage 5 review
        needs_stage_5 = True

    if needs_stage_5:
        evidence = {
            "applicant": {
                "name": ctx.get("applicant_name", ""),
                "curp": ctx.get("curp", ""),
                "monthly_salary_mxn": ctx.get("monthly_salary_mxn", 0),
                "requested_amount_mxn": ctx.get("requested_amount_mxn", 0),
                "employer_name": ctx.get("employer_name", ""),
                "employer_tier": ctx.get("employer_tier", 0),
                "tenure_months": ctx.get("tenure_months", 0),
            },
            "bureau": {
                "score": ctx.get("bureau_score"),
                "dias_atraso": ctx.get("dias_atraso", 0),
                "cartera_vencida": ctx.get("cartera_vencida", False),
                "cuentas_activas": ctx.get("cuentas_activas", 0),
                "reason": next(
                    (sr["reason"] for sr in stage_results if sr["stage"] == 3),
                    None,
                ),
            },
            "scorecard": scorecard_dict,
            "fraud": ctx.get("_fraud_result", {}),
            "pld": {
                "bloqueo_lista_sat": ctx.get("pld_bloqueo_lista_sat", False),
                "bloqueado": ctx.get("pld_bloqueado", False),
                "hard_reject": ctx.get("pld_bloqueo_lista_sat", False),
            },
            "aml": {
                "criminal_records": ctx.get("aml_criminal_records"),
                "pep_match": ctx.get("aml_pep_match", False),
                "sanctions_match": ctx.get("aml_sanctions_match", False),
                "risk_level": ctx.get("aml_risk_level", "unknown"),
            },
            "behavioral": {
                "risk_level": ctx.get("sardine_risk_level", "unknown"),
                "score": ctx.get("behavioral_risk_score", 0),
                "signals": {
                    "bot_detected": ctx.get("sardine_bot_detected", False),
                },
            },
            "stage_results": stage_results,
        }

        s5_result = _stage_5(ctx, evidence)
        reached_stage = 5
        sr_dict = {
            "stage": 5,
            "outcome": s5_result.outcome.value,
            "reason": s5_result.reason,
            "data": s5_result.data,
            "latency_ms": s5_result.latency_ms,
            "pass": s5_result.outcome != StageOutcome.REJECT,
        }
        stage_results.append(sr_dict)
        llm_judge_dict = ctx.get("_llm_judge_result", {})

        if s5_result.outcome == StageOutcome.REJECT:
            rejected = True
        elif s5_result.outcome == StageOutcome.FLAG:
            flags.append(f"stage_5:{s5_result.reason}")

    # Determine final decision
    if rejected:
        final_decision = "rejected"
    elif flags and any("stage_5:llm_judge_escalate" in f for f in flags):
        final_decision = "manual_review"
    elif flags and any("stage_5:llm_judge_conditional_approve" in f for f in flags):
        final_decision = "conditionally_approved"
    elif not rejected and reached_stage >= 3 and not needs_stage_5:
        final_decision = "approved"
    elif flags:
        # Had flags but Stage 5 approved conditionally
        final_decision = "conditionally_approved"
    else:
        final_decision = "approved"

    total_latency = int((time.time() - pipeline_start) * 1000)

    return PipelineResult(
        application_id=app_id,
        final_decision=final_decision,
        final_stage=reached_stage,
        credit_score=sc_result.credit_score,
        recommended_limit_mxn=sc_result.recommended_limit_mxn,
        pd=sc_result.pd,
        risk_grade=sc_result.risk_grade,
        scorecard=scorecard_dict,
        fraud=ctx.get("_fraud_result", {}),
        llm_judge=llm_judge_dict,
        stage_results=stage_results,
        flags=flags,
        total_latency_ms=total_latency,
        ts=int(time.time()),
    )
