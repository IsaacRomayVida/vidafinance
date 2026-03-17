"""Tests for LLM-as-Judge (fallback rule-based mode)."""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from llm_judge import judge, _fallback_rule_judge, _build_evidence_prompt


class TestFallbackJudge:
    """Tests run without ANTHROPIC_API_KEY so they use the rule-based fallback."""

    def test_pld_blacklist_rejects(self):
        result = _fallback_rule_judge({
            "pld": {"bloqueo_lista_sat": True, "hard_reject": True},
        })
        assert result.decision == "REJECT"
        assert result.confidence >= 0.9
        assert any("SAT" in f or "PLD" in f for f in result.risk_factors)

    def test_sanctions_rejects(self):
        result = _fallback_rule_judge({
            "aml": {"sanctions_match": True},
        })
        assert result.decision == "REJECT"

    def test_criminal_records_rejects(self):
        result = _fallback_rule_judge({
            "aml": {"criminal_records": "theft_2020"},
        })
        assert result.decision == "REJECT"

    def test_borderline_with_mitigating_approves_conditional(self):
        result = _fallback_rule_judge({
            "bureau": {"score": 420, "dias_atraso": 5},
            "fraud": {"anomaly_score": 30, "is_fraud": False},
            "scorecard": {"credit_score": 550},
            "applicant": {"tenure_months": 36, "monthly_salary_mxn": 20000},
            "pld": {},
            "aml": {},
        })
        assert result.decision == "APPROVE_WITH_CONDITIONS"
        assert result.recommended_limit_mxn > 0
        assert len(result.conditions) > 0

    def test_multiple_risks_escalates(self):
        result = _fallback_rule_judge({
            "bureau": {"score": 380, "dias_atraso": 35, "cartera_vencida": True},
            "fraud": {"anomaly_score": 70, "is_fraud": True},
            "scorecard": {"credit_score": 400},
            "applicant": {"tenure_months": 6},
            "pld": {},
            "aml": {},
        })
        assert result.decision in ("REJECT", "ESCALATE_TO_HUMAN")

    def test_clean_aml_escalates_by_default(self):
        result = _fallback_rule_judge({
            "pld": {},
            "aml": {},
            "bureau": {},
            "fraud": {},
            "scorecard": {},
            "applicant": {},
        })
        assert result.decision == "ESCALATE_TO_HUMAN"


class TestEvidencePrompt:
    def test_builds_prompt_string(self):
        prompt = _build_evidence_prompt({
            "applicant": {"name": "Test", "monthly_salary_mxn": 15000, "requested_amount_mxn": 3000},
            "bureau": {"score": 550, "dias_atraso": 10},
        })
        assert "Test" in prompt
        assert "550" in prompt
        assert "Stage 5" in prompt or "Review" in prompt


class TestJudgeEntrypoint:
    def test_returns_result_without_api_key(self):
        """Without ANTHROPIC_API_KEY set, should use fallback."""
        os.environ.pop("ANTHROPIC_API_KEY", None)
        result = judge({"pld": {}, "aml": {}, "bureau": {}, "fraud": {}, "scorecard": {}, "applicant": {}})
        assert result.decision in ("APPROVE_WITH_CONDITIONS", "REJECT", "ESCALATE_TO_HUMAN")
        assert result.model == "rule_fallback_v1"
