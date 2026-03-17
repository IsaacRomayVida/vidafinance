"""Claude LLM-as-Judge for Stage 5 borderline underwriting decisions.

Sends a structured prompt to Claude and expects a JSON response with
decision, confidence, reasoning, and risk flags.  If the API is unavailable
or returns invalid JSON, a deterministic fallback based on PD + fraud score
is used to guarantee a decision is always produced.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import List, Literal, Optional

# Module-level import so it can be patched in tests; silently absent when not installed
try:
    import anthropic  # noqa: F401 — used inside run_llm_judge
except ImportError:
    anthropic = None  # type: ignore[assignment]

logger = logging.getLogger("ml-service.llm_judge")

LLMDecision = Literal["approved", "rejected", "manual_review"]

_SYSTEM_PROMPT = (
    "You are a senior credit risk analyst for VIDA Finance, a Mexican payroll-backed "
    "SOFOM regulated by CNBV. You evaluate borderline loan applications and must "
    "strictly follow CNBV consumer-credit guidelines. Respond ONLY with valid JSON."
)

_USER_TEMPLATE = """
Evaluate this borderline loan application and return a JSON decision.

Applicant profile:
- Monthly salary: MXN {monthly_salary:,.0f}
- Requested amount: MXN {principal_amount:,.0f}
- Employment tenure: {tenure_months} months
- Employment type: {employment_type}
- Probability of Default (model estimate): {pd_estimate:.1%}
- Credit score: {credit_score} / 850  (risk grade: {risk_grade})
- Fraud score: {fraud_score:.0f} / 100
- KYC confidence: {kyc_confidence:.0f}%
- Bureau record: {bureau_record}
- Bureau score: {bureau_score}
- AML / sanctions: {aml_status}
- Stage reached: {stage_reached}

Required JSON response (no additional text):
{{
  "decision": "approved" | "rejected" | "manual_review",
  "confidence": 0.0-1.0,
  "reasoning": "one clear sentence",
  "red_flags": ["list", "of", "concerns"],
  "green_flags": ["list", "of", "positive", "signals"],
  "recommended_amount": <integer MXN or null>
}}
"""


@dataclass
class LLMJudgeResult:
    decision: LLMDecision
    confidence: float
    reasoning: str
    red_flags: List[str] = field(default_factory=list)
    green_flags: List[str] = field(default_factory=list)
    recommended_amount: Optional[int] = None
    used_fallback: bool = False
    raw_response: Optional[str] = None


# ---------------------------------------------------------------------------
# Deterministic fallback (no API key / API failure)
# ---------------------------------------------------------------------------

def _fallback_decision(pd_estimate: float, fraud_score: float) -> LLMJudgeResult:
    """Rule-based tiebreaker when Claude is unavailable."""
    if pd_estimate < 0.15 and fraud_score < 30:
        decision: LLMDecision = "approved"
        reasoning = "Low PD and low fraud signal qualify applicant for approval."
        green = ["PD below 15%", "Low fraud score"]
        red: List[str] = []
    elif pd_estimate > 0.28 or fraud_score >= 50:
        decision = "rejected"
        reasoning = "Elevated default risk or fraud signal exceeds acceptable threshold."
        red = []
        if pd_estimate > 0.28:
            red.append(f"PD {pd_estimate:.1%} exceeds 28% threshold")
        if fraud_score >= 50:
            red.append(f"Fraud score {fraud_score:.0f} ≥ 50")
        green = []
    else:
        decision = "manual_review"
        reasoning = "Borderline risk profile requires human underwriter review."
        red = [f"Borderline PD {pd_estimate:.1%}"]
        green = []

    return LLMJudgeResult(
        decision=decision,
        confidence=0.70,
        reasoning=reasoning,
        red_flags=red,
        green_flags=green,
        used_fallback=True,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_llm_judge(
    *,
    monthly_salary: float,
    principal_amount: float,
    tenure_months: int,
    employment_type: str,
    pd_estimate: float,
    credit_score: int,
    risk_grade: str,
    fraud_score: float,
    kyc_confidence: float,
    bureau_record: bool,
    bureau_score: Optional[float],
    aml_clear: bool,
    stage_reached: int,
    anthropic_api_key: Optional[str] = None,
) -> LLMJudgeResult:
    """Call Claude claude-sonnet-4-20250514 to adjudicate a borderline application.

    Falls back to rule-based decision if the API key is absent or the call fails.
    """
    api_key = anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    if not api_key:
        logger.debug("No ANTHROPIC_API_KEY — using deterministic fallback")
        return _fallback_decision(pd_estimate, fraud_score)

    prompt = _USER_TEMPLATE.format(
        monthly_salary=monthly_salary,
        principal_amount=principal_amount,
        tenure_months=tenure_months,
        employment_type=employment_type,
        pd_estimate=pd_estimate,
        credit_score=credit_score,
        risk_grade=risk_grade,
        fraud_score=fraud_score,
        kyc_confidence=kyc_confidence,
        bureau_record="Yes" if bureau_record else "No",
        bureau_score=f"{bureau_score:.0f}" if bureau_score else "N/A",
        aml_status="Clear" if aml_clear else "FLAGGED",
        stage_reached=stage_reached,
    )

    try:
        if anthropic is None:
            raise ImportError("anthropic package not available")

        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=512,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()

        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        parsed = json.loads(raw)

        decision_raw = parsed.get("decision", "manual_review")
        if decision_raw not in ("approved", "rejected", "manual_review"):
            decision_raw = "manual_review"

        return LLMJudgeResult(
            decision=decision_raw,  # type: ignore[arg-type]
            confidence=float(parsed.get("confidence", 0.5)),
            reasoning=str(parsed.get("reasoning", "")),
            red_flags=list(parsed.get("red_flags", [])),
            green_flags=list(parsed.get("green_flags", [])),
            recommended_amount=parsed.get("recommended_amount"),
            used_fallback=False,
            raw_response=raw,
        )

    except Exception as exc:
        logger.warning("LLM judge failed (%s) — using fallback", exc)
        result = _fallback_decision(pd_estimate, fraud_score)
        result.raw_response = str(exc)
        return result
