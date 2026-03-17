"""
llm_judge.py
Claude LLM-as-Judge for Stage 5 escalation decisions.

When an application reaches Stage 5 (high risk / AML flags / bureau reject),
the LLM Judge reviews all accumulated evidence and produces a structured
decision: APPROVE_WITH_CONDITIONS, REJECT, or ESCALATE_TO_HUMAN.

The judge is conservative by design — it cannot auto-approve at Stage 5,
only recommend conditional approval or escalation.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

SYSTEM_PROMPT = """You are the final-stage credit risk adjudicator for VIDA Finance, \
a Mexican SOFOM (Sociedad Financiera de Objeto Múltiple) that provides payroll-deduction \
micro-loans (up to $5,000 MXN, 30-day term, 30% monthly interest).

You are reviewing a Stage 5 escalation — the applicant has been flagged by earlier \
stages of our automated underwriting pipeline. Your job is to review ALL evidence \
and make a final recommendation.

IMPORTANT RULES:
1. You CANNOT auto-approve. Your options are: APPROVE_WITH_CONDITIONS, REJECT, or ESCALATE_TO_HUMAN.
2. If AML/PLD flags are present (SAT blacklist, sanctions match), you MUST REJECT or ESCALATE_TO_HUMAN.
3. If criminal records are confirmed, you MUST REJECT.
4. If fraud signals are high (anomaly_score >= 65), lean toward REJECT.
5. For borderline cases (bureau score 350-450, minor late payments), consider APPROVE_WITH_CONDITIONS \
   with a reduced limit.
6. Always explain your reasoning in 2-3 sentences.

Respond ONLY with valid JSON matching this schema:
{
  "decision": "APPROVE_WITH_CONDITIONS" | "REJECT" | "ESCALATE_TO_HUMAN",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentence explanation",
  "conditions": ["list of conditions if APPROVE_WITH_CONDITIONS, else empty"],
  "risk_factors": ["key risk factors identified"],
  "mitigating_factors": ["any positive signals"],
  "recommended_limit_mxn": 0-5000 (0 if REJECT),
  "escalation_reason": "why human review needed (if ESCALATE_TO_HUMAN, else null)"
}"""


@dataclass
class JudgeResult:
    decision: str                              # APPROVE_WITH_CONDITIONS | REJECT | ESCALATE_TO_HUMAN
    confidence: float = 0.0
    reasoning: str = ""
    conditions: list[str] = field(default_factory=list)
    risk_factors: list[str] = field(default_factory=list)
    mitigating_factors: list[str] = field(default_factory=list)
    recommended_limit_mxn: float = 0.0
    escalation_reason: str | None = None
    model: str = "claude_llm_judge_v1"
    latency_ms: int = 0
    error: str | None = None


def _build_evidence_prompt(evidence: dict) -> str:
    """Format all pipeline evidence into a structured prompt for the LLM."""
    sections = []

    # Applicant info
    applicant = evidence.get("applicant", {})
    if applicant:
        sections.append(
            f"## Applicant\n"
            f"- Name: {applicant.get('name', 'N/A')}\n"
            f"- CURP: {applicant.get('curp', 'N/A')}\n"
            f"- Monthly salary: ${applicant.get('monthly_salary_mxn', 'N/A'):,} MXN\n"
            f"- Requested amount: ${applicant.get('requested_amount_mxn', 'N/A'):,} MXN\n"
            f"- Employer: {applicant.get('employer_name', 'N/A')} (Tier {applicant.get('employer_tier', 'N/A')})\n"
            f"- Tenure: {applicant.get('tenure_months', 'N/A')} months"
        )

    # Bureau data
    bureau = evidence.get("bureau", {})
    if bureau:
        sections.append(
            f"## Credit Bureau (SoftCrédito)\n"
            f"- Score: {bureau.get('score', 'N/A')}\n"
            f"- Days late (diasAtraso): {bureau.get('dias_atraso', 0)}\n"
            f"- Active default (carteraVencida): {bureau.get('cartera_vencida', False)}\n"
            f"- Active accounts: {bureau.get('cuentas_activas', 'N/A')}\n"
            f"- Stage escalation reason: {bureau.get('reason', 'N/A')}"
        )

    # WoE scorecard
    scorecard = evidence.get("scorecard", {})
    if scorecard:
        sections.append(
            f"## WoE Scorecard\n"
            f"- Credit score: {scorecard.get('credit_score', 'N/A')}\n"
            f"- PD (probability of default): {scorecard.get('pd', 'N/A')}\n"
            f"- Risk grade: {scorecard.get('risk_grade', 'N/A')}\n"
            f"- Recommended limit: ${scorecard.get('recommended_limit_mxn', 0):,} MXN"
        )

    # Fraud detection
    fraud = evidence.get("fraud", {})
    if fraud:
        sections.append(
            f"## Fraud Detection (Isolation Forest)\n"
            f"- Anomaly score: {fraud.get('anomaly_score', 'N/A')}/100\n"
            f"- Is fraud: {fraud.get('is_fraud', False)}\n"
            f"- Hard flags: {', '.join(fraud.get('hard_flags', [])) or 'None'}"
        )

    # AML / PLD
    pld = evidence.get("pld", {})
    if pld:
        sections.append(
            f"## AML / PLD Screening\n"
            f"- SAT blacklist: {pld.get('bloqueo_lista_sat', False)}\n"
            f"- Blocked: {pld.get('bloqueado', False)}\n"
            f"- Hard reject: {pld.get('hard_reject', False)}"
        )

    # AML watchlists (Truora)
    aml = evidence.get("aml", {})
    if aml:
        sections.append(
            f"## AML Watchlists (Truora)\n"
            f"- Criminal records: {aml.get('criminal_records', 'None')}\n"
            f"- PEP match: {aml.get('pep_match', False)}\n"
            f"- Sanctions match: {aml.get('sanctions_match', False)}\n"
            f"- AML risk level: {aml.get('risk_level', 'N/A')}"
        )

    # Behavioral biometrics
    behavioral = evidence.get("behavioral", {})
    if behavioral:
        sections.append(
            f"## Behavioral Biometrics (Sardine)\n"
            f"- Risk level: {behavioral.get('risk_level', 'N/A')}\n"
            f"- Score: {behavioral.get('score', 'N/A')}\n"
            f"- Bot detected: {behavioral.get('signals', {}).get('bot_detected', False)}"
        )

    # Stage history
    stages = evidence.get("stage_results", [])
    if stages:
        lines = [f"## Pipeline Stage History"]
        for s in stages:
            lines.append(f"- Stage {s.get('stage', '?')}: {'PASS' if s.get('pass') else 'FAIL/FLAG'} — {s.get('reason', 'ok')}")
        sections.append("\n".join(lines))

    prompt = (
        "Review the following underwriting evidence for a Stage 5 escalated application "
        "and provide your adjudication decision.\n\n"
        + "\n\n".join(sections)
    )
    return prompt


def judge(evidence: dict) -> JudgeResult:
    """Run LLM-as-Judge on Stage 5 escalated evidence.

    Parameters
    ----------
    evidence : dict
        Accumulated evidence from all pipeline stages. Expected keys:
        applicant, bureau, scorecard, fraud, pld, aml, behavioral, stage_results.

    Returns
    -------
    JudgeResult
    """
    if not ANTHROPIC_API_KEY:
        return _fallback_rule_judge(evidence)

    start = time.time()
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        prompt = _build_evidence_prompt(evidence)

        msg = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=600,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )

        latency = int((time.time() - start) * 1000)
        raw = msg.content[0].text
        parsed = json.loads(raw)

        return JudgeResult(
            decision=parsed.get("decision", "ESCALATE_TO_HUMAN"),
            confidence=parsed.get("confidence", 0.0),
            reasoning=parsed.get("reasoning", ""),
            conditions=parsed.get("conditions", []),
            risk_factors=parsed.get("risk_factors", []),
            mitigating_factors=parsed.get("mitigating_factors", []),
            recommended_limit_mxn=parsed.get("recommended_limit_mxn", 0),
            escalation_reason=parsed.get("escalation_reason"),
            latency_ms=latency,
        )
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        # Fallback to rule-based judge on LLM failure
        result = _fallback_rule_judge(evidence)
        result.error = f"LLM fallback: {str(e)[:200]}"
        result.latency_ms = latency
        return result


def _fallback_rule_judge(evidence: dict) -> JudgeResult:
    """Deterministic fallback when LLM is unavailable.

    Conservative: rejects on hard signals, escalates everything else.
    """
    pld = evidence.get("pld", {})
    aml = evidence.get("aml", {})
    fraud = evidence.get("fraud", {})
    bureau = evidence.get("bureau", {})

    risk_factors = []
    mitigating = []

    # Hard reject signals
    if pld.get("bloqueo_lista_sat") or pld.get("hard_reject"):
        risk_factors.append("SAT/PLD blacklist match")
    if aml.get("sanctions_match"):
        risk_factors.append("Sanctions list match")
    if aml.get("criminal_records") and aml["criminal_records"] != "None":
        risk_factors.append("Criminal records found")

    if risk_factors:
        return JudgeResult(
            decision="REJECT",
            confidence=0.95,
            reasoning=f"Hard reject: {'; '.join(risk_factors)}. Regulatory compliance requires rejection.",
            risk_factors=risk_factors,
            recommended_limit_mxn=0,
            model="rule_fallback_v1",
        )

    # Fraud signals
    if fraud.get("is_fraud") or fraud.get("anomaly_score", 0) >= 65:
        risk_factors.append(f"High fraud score ({fraud.get('anomaly_score', 0)})")

    # Bureau signals
    score = bureau.get("score", 0)
    if score and score < 400:
        risk_factors.append(f"Bureau score {score} < 400")
    if bureau.get("dias_atraso", 0) >= 31:
        risk_factors.append(f"Days late: {bureau.get('dias_atraso')}")
    if bureau.get("cartera_vencida"):
        risk_factors.append("Active default (cartera vencida)")

    # Mitigating factors
    scorecard = evidence.get("scorecard", {})
    if scorecard.get("credit_score", 0) >= 500:
        mitigating.append(f"WoE score {scorecard['credit_score']} shows moderate creditworthiness")
    applicant = evidence.get("applicant", {})
    if applicant.get("tenure_months", 0) >= 24:
        mitigating.append(f"Stable employment ({applicant['tenure_months']} months)")

    # Borderline: approve with conditions if mitigating factors exist
    if len(risk_factors) <= 1 and len(mitigating) > 0:
        salary = applicant.get("monthly_salary_mxn", 0)
        reduced_limit = min(2500, round(salary * 0.15 / 100) * 100) if salary else 1000
        return JudgeResult(
            decision="APPROVE_WITH_CONDITIONS",
            confidence=0.55,
            reasoning="Borderline case with mitigating factors. Recommending reduced limit.",
            conditions=["Reduced credit limit", "30-day monitoring period"],
            risk_factors=risk_factors,
            mitigating_factors=mitigating,
            recommended_limit_mxn=reduced_limit,
            model="rule_fallback_v1",
        )

    # Default: escalate to human
    return JudgeResult(
        decision="ESCALATE_TO_HUMAN",
        confidence=0.50,
        reasoning="Multiple risk signals require human review. Automated assessment insufficient.",
        risk_factors=risk_factors,
        mitigating_factors=mitigating,
        escalation_reason="Complex risk profile — automated rules cannot determine outcome",
        model="rule_fallback_v1",
    )
