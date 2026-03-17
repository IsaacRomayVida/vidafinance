"""Tests for Decision Tree stages 0-5 pipeline."""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from decision_tree import (
    run_pipeline,
    _stage_0, _stage_1, _stage_2, _stage_3, _stage_4,
    StageOutcome,
)


class TestStage0:
    def test_pass_normal(self):
        r = _stage_0({"device_risk_score": 10, "monthly_salary_mxn": 15000, "infonavit_monthly_deduction": 1000})
        assert r.outcome == StageOutcome.PASS

    def test_reject_extreme_device_fraud(self):
        r = _stage_0({"device_risk_score": 95})
        assert r.outcome == StageOutcome.REJECT
        assert "device_fraud" in r.reason

    def test_flag_elevated_device_risk(self):
        r = _stage_0({"device_risk_score": 70})
        assert r.outcome == StageOutcome.FLAG

    def test_flag_high_infonavit(self):
        r = _stage_0({"device_risk_score": 5, "monthly_salary_mxn": 10000, "infonavit_monthly_deduction": 4000})
        assert r.outcome == StageOutcome.FLAG
        assert "infonavit" in r.reason


class TestStage1:
    def test_skip_non_government(self):
        r = _stage_1({"is_government_employer": False})
        assert r.outcome == StageOutcome.PASS
        assert "skip" in r.reason

    def test_reject_inactive_issste(self):
        r = _stage_1({"is_government_employer": True, "issste_active": False})
        assert r.outcome == StageOutcome.REJECT

    def test_flag_salary_mismatch(self):
        r = _stage_1({
            "is_government_employer": True, "issste_active": True,
            "issste_salary_sbc": 20000, "monthly_salary_mxn": 10000,
        })
        assert r.outcome == StageOutcome.FLAG
        assert "salary_mismatch" in r.reason

    def test_pass_government_ok(self):
        r = _stage_1({
            "is_government_employer": True, "issste_active": True,
            "issste_salary_sbc": 15000, "monthly_salary_mxn": 15000,
        })
        assert r.outcome == StageOutcome.PASS


class TestStage2:
    def test_reject_no_imss(self):
        r = _stage_2({"imss_active": False})
        assert r.outcome == StageOutcome.REJECT

    def test_flag_zero_afore(self):
        r = _stage_2({"imss_active": True, "afore_balance_mxn": 0, "tenure_months": 24})
        assert r.outcome == StageOutcome.FLAG
        assert "afore" in r.reason

    def test_flag_short_tenure(self):
        r = _stage_2({"imss_active": True, "afore_balance_mxn": 50000, "tenure_months": 2})
        assert r.outcome == StageOutcome.FLAG
        assert "tenure" in r.reason

    def test_pass_good_employment(self):
        r = _stage_2({
            "imss_active": True, "imss_salary_sbc": 15000, "monthly_salary_mxn": 15000,
            "afore_balance_mxn": 50000, "tenure_months": 24,
        })
        assert r.outcome == StageOutcome.PASS


class TestStage3:
    def test_pass_auto_approve(self):
        r = _stage_3({
            "bureau_score": 700, "dias_atraso": 0, "cartera_vencida": False,
            "kyc_verified": True, "pld_bloqueo_lista_sat": False,
        })
        assert r.outcome == StageOutcome.PASS
        assert "auto_approve" in r.reason

    def test_reject_kyc_failed(self):
        r = _stage_3({"kyc_verified": False})
        assert r.outcome == StageOutcome.REJECT

    def test_reject_pld_blacklist(self):
        r = _stage_3({"kyc_verified": True, "pld_bloqueo_lista_sat": True})
        assert r.outcome == StageOutcome.REJECT
        assert "pld" in r.reason

    def test_reject_active_default(self):
        r = _stage_3({"kyc_verified": True, "cartera_vencida": True})
        assert r.outcome == StageOutcome.REJECT

    def test_reject_score_below_400(self):
        r = _stage_3({"kyc_verified": True, "bureau_score": 350})
        assert r.outcome == StageOutcome.REJECT
        assert "score_below_400" in r.reason

    def test_flag_score_400_599(self):
        r = _stage_3({"kyc_verified": True, "bureau_score": 500, "dias_atraso": 0})
        assert r.outcome == StageOutcome.FLAG
        assert "score_400_599" in r.reason

    def test_flag_days_late_1_30(self):
        r = _stage_3({"kyc_verified": True, "bureau_score": 650, "dias_atraso": 15})
        assert r.outcome == StageOutcome.FLAG
        assert "days_late" in r.reason

    def test_reject_days_late_31_plus(self):
        r = _stage_3({"kyc_verified": True, "bureau_score": 650, "dias_atraso": 45})
        assert r.outcome == StageOutcome.REJECT


class TestStage4:
    def test_pass_clean(self):
        r = _stage_4({
            "requests_last_hour": 0, "amount_to_salary_ratio": 0.15,
            "device_risk_score": 10, "behavioral_risk_score": 10,
            "sardine_pass": True, "sardine_risk_level": "low",
        })
        assert r.outcome == StageOutcome.PASS

    def test_reject_multi_fraud_flags(self):
        r = _stage_4({
            "requests_last_hour": 10, "device_risk_score": 95,
            "ip_country_mismatch": True, "amount_to_salary_ratio": 0.50,
            "behavioral_risk_score": 90,
            "sardine_pass": True, "sardine_risk_level": "low",
        })
        assert r.outcome == StageOutcome.REJECT

    def test_reject_bot_detected(self):
        r = _stage_4({
            "sardine_pass": False, "sardine_risk_level": "very_high",
        })
        assert r.outcome == StageOutcome.REJECT
        assert "bot" in r.reason

    def test_flag_single_fraud_signal(self):
        r = _stage_4({
            "requests_last_hour": 8,  # hard flag
            "sardine_pass": True, "sardine_risk_level": "low",
        })
        assert r.outcome in (StageOutcome.FLAG, StageOutcome.REJECT)


class TestPipelineIntegration:
    def test_good_applicant_approved(self):
        """Clean applicant with good bureau score should be approved."""
        result = run_pipeline({
            "application_id": "test_good_001",
            "monthly_salary_mxn": 20000,
            "bureau_score": 720,
            "employer_tier": 1,
            "dias_atraso": 0,
            "cartera_vencida": False,
            "kyc_verified": True,
            "imss_active": True,
            "tenure_months": 36,
            "afore_balance_mxn": 80000,
            "existing_loans": 0,
            "device_risk_score": 5,
            "sardine_pass": True,
            "sardine_risk_level": "low",
        })
        assert result.final_decision == "approved"
        assert result.credit_score >= 700
        assert result.recommended_limit_mxn > 0
        assert result.pd < 0.05
        assert len(result.stage_results) >= 5  # stages 0-4

    def test_pld_blacklist_rejected(self):
        """PLD blacklist should trigger rejection via Stage 3 → Stage 5."""
        result = run_pipeline({
            "application_id": "test_pld_001",
            "monthly_salary_mxn": 20000,
            "bureau_score": 700,
            "employer_tier": 1,
            "kyc_verified": True,
            "imss_active": True,
            "pld_bloqueo_lista_sat": True,
        })
        assert result.final_decision == "rejected"

    def test_low_bureau_score_stage5(self):
        """Low bureau score should escalate to Stage 5."""
        result = run_pipeline({
            "application_id": "test_lowscore_001",
            "monthly_salary_mxn": 15000,
            "bureau_score": 380,
            "employer_tier": 2,
            "kyc_verified": True,
            "imss_active": True,
            "tenure_months": 12,
            "afore_balance_mxn": 20000,
        })
        assert result.final_stage == 5
        assert any(sr["stage"] == 5 for sr in result.stage_results)

    def test_mid_bureau_flagged_continues(self):
        """Bureau score 400-599 should flag at Stage 3 but continue."""
        result = run_pipeline({
            "application_id": "test_mid_001",
            "monthly_salary_mxn": 18000,
            "bureau_score": 520,
            "employer_tier": 2,
            "dias_atraso": 0,
            "kyc_verified": True,
            "imss_active": True,
            "tenure_months": 24,
            "afore_balance_mxn": 40000,
            "sardine_pass": True,
            "sardine_risk_level": "low",
        })
        assert len(result.flags) > 0
        assert result.final_stage >= 4

    def test_result_has_scorecard(self):
        result = run_pipeline({
            "monthly_salary_mxn": 15000,
            "bureau_score": 600,
            "employer_tier": 2,
            "kyc_verified": True,
            "imss_active": True,
        })
        assert "credit_score" in result.scorecard
        assert "pd" in result.scorecard
        assert "risk_grade" in result.scorecard

    def test_result_model_version(self):
        result = run_pipeline({"monthly_salary_mxn": 15000, "bureau_score": 600})
        assert result.model_version == "decision_tree_v1"
        assert result.ts > 0
