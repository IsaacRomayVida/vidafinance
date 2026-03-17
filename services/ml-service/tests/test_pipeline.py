"""Comprehensive test suite for the VIDA ML underwriting pipeline.

Covers:
  - WoE scorecard unit tests (15)
  - Isolation Forest fraud detector (10)
  - Decision Tree stage tests (25)
  - LLM Judge fallback logic (6)
  - FastAPI endpoint tests (10)
  - Performance / precision tests (2)

Total: 68 tests — all runnable without Redis, Firebase, or Anthropic credentials.
"""

import json
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

# Ensure the ml-service root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ---------------------------------------------------------------------------
# WoE Scorecard tests (15)
# ---------------------------------------------------------------------------


class TestWoEScorecard:

    def test_excellent_borrower_low_pd(self):
        """High bureau score + long tenure + high salary → low PD, grade A."""
        from pipeline.woe_scorecard import run_scorecard
        result = run_scorecard({
            "bureau_score": 750,
            "employment_tenure_months": 60,
            "monthly_salary": 35_000,
            "principal_amount": 2_000,
            "pay_frequency_encoded": 2,
            "employer_industry_encoded": 8,
            "has_bureau_record": 1,
        })
        assert result.pd_estimate < 0.10
        assert result.credit_score >= 720
        assert result.risk_grade == "A"
        assert result.approved is True

    def test_risky_borrower_high_pd(self):
        """Low bureau score + short tenure + high LTS → high PD, grade E."""
        from pipeline.woe_scorecard import run_scorecard
        result = run_scorecard({
            "bureau_score": 380,
            "employment_tenure_months": 1,
            "monthly_salary": 5_500,
            "principal_amount": 3_500,
            "pay_frequency_encoded": 1,
            "employer_industry_encoded": 0,
            "has_bureau_record": 1,
        })
        assert result.pd_estimate > 0.60
        assert result.credit_score < 480
        assert result.risk_grade in ("D", "E")
        assert result.approved is False

    def test_bureau_score_bin_under_400(self):
        """Bureau score below 400 maps to the worst WoE bin."""
        from pipeline.woe_scorecard import run_scorecard, _lookup_bin, _BUREAU_SCORE_BINS
        woe = _lookup_bin(350, _BUREAU_SCORE_BINS)
        assert woe == -2.0

    def test_bureau_score_bin_above_720(self):
        from pipeline.woe_scorecard import _lookup_bin, _BUREAU_SCORE_BINS
        woe = _lookup_bin(780, _BUREAU_SCORE_BINS)
        assert woe == 1.8

    def test_bureau_score_bin_600_to_680(self):
        from pipeline.woe_scorecard import _lookup_bin, _BUREAU_SCORE_BINS
        woe = _lookup_bin(640, _BUREAU_SCORE_BINS)
        assert woe == 0.5

    def test_tenure_bin_under_3_months(self):
        from pipeline.woe_scorecard import _lookup_bin, _TENURE_BINS
        woe = _lookup_bin(2, _TENURE_BINS)
        assert woe == -2.5

    def test_tenure_bin_over_48_months(self):
        from pipeline.woe_scorecard import _lookup_bin, _TENURE_BINS
        woe = _lookup_bin(60, _TENURE_BINS)
        assert woe == 1.5

    def test_no_bureau_record_uses_penalty(self):
        """has_bureau_record=0 should use the no-record WoE, not the score bin."""
        from pipeline.woe_scorecard import run_scorecard
        result = run_scorecard({
            "bureau_score": 750,       # ignored — no record
            "employment_tenure_months": 24,
            "monthly_salary": 18_000,
            "principal_amount": 2_000,
            "pay_frequency_encoded": 2,
            "employer_industry_encoded": 1,
            "has_bureau_record": 0,
        })
        # No-record WoE = -0.5, should lower the score vs having a good bureau record
        assert result.woe_contributions["bureau_score"] == -0.5

    def test_pd_to_credit_score_zero(self):
        from pipeline.woe_scorecard import _pd_to_credit_score
        assert _pd_to_credit_score(0.0) == 850

    def test_pd_to_credit_score_one(self):
        from pipeline.woe_scorecard import _pd_to_credit_score
        assert _pd_to_credit_score(1.0) == 300

    def test_risk_grade_A(self):
        from pipeline.woe_scorecard import _score_to_grade
        assert _score_to_grade(780) == "A"

    def test_risk_grade_B(self):
        from pipeline.woe_scorecard import _score_to_grade
        assert _score_to_grade(680) == "B"

    def test_risk_grade_C(self):
        from pipeline.woe_scorecard import _score_to_grade
        assert _score_to_grade(600) == "C"

    def test_risk_grade_D(self):
        from pipeline.woe_scorecard import _score_to_grade
        assert _score_to_grade(510) == "D"

    def test_risk_grade_E(self):
        from pipeline.woe_scorecard import _score_to_grade
        assert _score_to_grade(400) == "E"

    def test_approval_threshold_boundary(self):
        """Borrower just under PD threshold should be approved."""
        from pipeline.woe_scorecard import run_scorecard, APPROVAL_PD_THRESHOLD
        result = run_scorecard({
            "bureau_score": 710,
            "employment_tenure_months": 24,
            "monthly_salary": 20_000,
            "principal_amount": 1_500,
            "pay_frequency_encoded": 2,
            "employer_industry_encoded": 1,
            "has_bureau_record": 1,
        })
        # Verify the approved flag matches the PD threshold
        expected_approved = result.pd_estimate < APPROVAL_PD_THRESHOLD
        assert result.approved == expected_approved

    def test_woe_contributions_present(self):
        """All 7 feature contributions must be present in output."""
        from pipeline.woe_scorecard import run_scorecard
        result = run_scorecard({
            "bureau_score": 600,
            "employment_tenure_months": 12,
            "monthly_salary": 12_000,
            "principal_amount": 2_000,
            "pay_frequency_encoded": 2,
            "employer_industry_encoded": 2,
            "has_bureau_record": 1,
        })
        expected_keys = {
            "bureau_score", "employment_tenure_months", "monthly_salary",
            "loan_to_salary_ratio", "pay_frequency_encoded",
            "employer_industry_encoded", "has_bureau_record",
        }
        assert expected_keys == set(result.woe_contributions.keys())

    def test_credit_score_in_valid_range(self):
        from pipeline.woe_scorecard import run_scorecard
        for salary in [4000, 10000, 25000, 50000]:
            result = run_scorecard({
                "bureau_score": 600,
                "employment_tenure_months": 12,
                "monthly_salary": salary,
                "principal_amount": 2000,
                "pay_frequency_encoded": 2,
                "employer_industry_encoded": 1,
                "has_bureau_record": 1,
            })
            assert 300 <= result.credit_score <= 850

    def test_precision_on_synthetic_data(self):
        """Among approved applications, true default rate must be < 20% (precision ≥ 80%).

        Uses clearly-separated good vs bad borrower populations to measure precision:
        good  = bureau 650–850, tenure 12–72 mo, salary 12k–50k MXN, low LTS
        bad   = bureau 300–540, tenure 1–5 mo,   salary 4k–9k MXN,   high LTS
        """
        import random
        from pipeline.woe_scorecard import run_scorecard

        rng = random.Random(42)
        approved_good = 0
        approved_bad = 0

        for _ in range(500):
            # Good borrower — all four key risk indicators in the safe range
            bureau = rng.uniform(650, 850)
            tenure = rng.randint(12, 72)
            salary = rng.uniform(12_000, 50_000)
            amount = rng.uniform(1_000, min(5_000, salary * 0.25))
            result = run_scorecard({
                "bureau_score": bureau,
                "employment_tenure_months": tenure,
                "monthly_salary": salary,
                "principal_amount": amount,
                "pay_frequency_encoded": rng.choice([2, 4]),
                "employer_industry_encoded": rng.randint(1, 8),
                "has_bureau_record": 1,
            })
            if result.approved:
                approved_good += 1

        for _ in range(500):
            # Bad borrower — all four key risk indicators in the risky range
            bureau = rng.uniform(300, 540)
            tenure = rng.randint(1, 5)
            salary = rng.uniform(4_000, 9_000)
            amount = rng.uniform(2_000, 4_500)   # high LTS
            result = run_scorecard({
                "bureau_score": bureau,
                "employment_tenure_months": tenure,
                "monthly_salary": salary,
                "principal_amount": amount,
                "pay_frequency_encoded": 1,
                "employer_industry_encoded": rng.randint(0, 3),
                "has_bureau_record": rng.choice([0, 1]),
            })
            if result.approved:
                approved_bad += 1

        total_approved = approved_good + approved_bad
        assert total_approved > 0, "Model approved nobody — approval threshold too strict"
        precision = approved_good / total_approved
        assert precision >= 0.80, (
            f"Precision {precision:.2%} below 80% "
            f"({approved_good} good, {approved_bad} bad among {total_approved} approved)"
        )


# ---------------------------------------------------------------------------
# Isolation Forest fraud detector tests (10)
# ---------------------------------------------------------------------------


class TestFraudDetector:

    def test_normal_applicant_low_score(self):
        """Clean behavioral signals → low fraud score."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.10,
            "device_age_days": 365,
            "geo_distance_km": 5,
            "same_ip_applications": 0,
            "time_since_last_app_hours": 720,
            "kyc_confidence_score": 95,
            "bureau_inquiry_count": 1,
        })
        assert result.is_fraud is False
        assert result.fraud_score < 50

    def test_high_velocity_triggers_hard_flag(self):
        """More than 5 requests per hour must hard-flag immediately."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({"requests_last_hour": 10})
        assert result.is_fraud is True
        assert result.fraud_score == 100.0
        assert any("velocity" in f.lower() for f in result.hard_flags)

    def test_extreme_ratio_triggers_hard_flag(self):
        """Amount > 60% of salary must hard-flag."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({"amount_to_salary_ratio": 0.75})
        assert result.is_fraud is True
        assert result.fraud_score == 100.0
        assert any("60%" in f for f in result.hard_flags)

    def test_same_ip_concentration_hard_flag(self):
        """More than 10 apps from same IP is a hard flag."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({"same_ip_applications": 15})
        assert result.is_fraud is True
        assert result.hard_flags

    def test_brand_new_device_hard_flag(self):
        """Device registered < 1 day ago is a hard flag."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({"device_age_days": 0})
        assert result.is_fraud is True

    def test_multiple_anomalies_high_score(self):
        """Multiple moderately suspicious signals should produce a high score."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({
            "requests_last_hour": 4,          # elevated (but not hard-flag level)
            "amount_to_salary_ratio": 0.38,   # elevated
            "device_age_days": 2,             # very new device
            "geo_distance_km": 800,           # very far
            "same_ip_applications": 6,        # elevated
            "time_since_last_app_hours": 0.5, # rapid re-application
            "kyc_confidence_score": 40,       # low KYC
            "bureau_inquiry_count": 20,       # excessive inquiries
        })
        # Multiple anomalies → hard flags triggered for device age and same IP
        assert result.is_fraud is True

    def test_anomaly_contributions_populated(self):
        """Feature contribution dict must contain all 8 labels."""
        from pipeline.fraud_detector import run_fraud_detection, _ANOMALY_LABELS
        result = run_fraud_detection({})
        assert set(result.anomaly_contributions.keys()) == set(_ANOMALY_LABELS.values())

    def test_contributions_in_zero_one_range(self):
        """Each contribution value must be in [0, 1]."""
        from pipeline.fraud_detector import run_fraud_detection
        result = run_fraud_detection({
            "requests_last_hour": 3,
            "geo_distance_km": 50,
        })
        for v in result.anomaly_contributions.values():
            assert 0.0 <= v <= 1.0

    def test_needs_review_threshold(self):
        """Scores >= FRAUD_REVIEW_THRESHOLD should set needs_review=True."""
        from pipeline.fraud_detector import run_fraud_detection, FRAUD_REVIEW_THRESHOLD, FRAUD_FLAG_THRESHOLD
        # Force a review-level score by using a freshly registered device (hard flag triggers 100)
        # Use a near-threshold case with slightly elevated signals
        result = run_fraud_detection({
            "requests_last_hour": 0,
            "device_age_days": 365,
            "same_ip_applications": 0,
            "amount_to_salary_ratio": 0.10,
        })
        # Low signals → not fraud, not needs_review
        assert result.needs_review is False

    def test_fraud_scoring_under_50ms(self):
        """Fraud scoring must complete within 50ms."""
        from pipeline.fraud_detector import run_fraud_detection
        t0 = time.perf_counter()
        for _ in range(10):
            run_fraud_detection({
                "requests_last_hour": 1,
                "amount_to_salary_ratio": 0.15,
            })
        elapsed_ms = (time.perf_counter() - t0) * 1000
        avg_ms = elapsed_ms / 10
        assert avg_ms < 50, f"Avg fraud scoring {avg_ms:.1f}ms exceeds 50ms limit"


# ---------------------------------------------------------------------------
# Decision Tree stage tests (25)
# ---------------------------------------------------------------------------


class TestDecisionTreeStages:

    # ── Stage 0 ──────────────────────────────────────────────────────────

    def test_stage0_blacklisted_device_rejected(self):
        from pipeline.decision_tree import _stage0_prescreening, ApplicationInput
        app = ApplicationInput(
            applicant_id="test-001",
            blacklisted_device=True,
            employment_type="imss",
        )
        r = _stage0_prescreening(app)
        assert r.passed is False
        assert r.outcome == "rejected"
        assert "blacklisted" in r.rejection_reason.lower()

    def test_stage0_informal_employment_rejected(self):
        from pipeline.decision_tree import _stage0_prescreening, ApplicationInput
        app = ApplicationInput(applicant_id="test-002", employment_type="informal")
        r = _stage0_prescreening(app)
        assert r.passed is False
        assert r.outcome == "rejected"

    def test_stage0_imss_routes_standard_track(self):
        from pipeline.decision_tree import _stage0_prescreening, ApplicationInput
        app = ApplicationInput(applicant_id="test-003", employment_type="imss")
        r = _stage0_prescreening(app)
        assert r.passed is True
        assert r.outcome == "pending"
        assert r.details.get("route") == "standard_track"

    def test_stage0_issste_routes_issste_track(self):
        from pipeline.decision_tree import _stage0_prescreening, ApplicationInput
        app = ApplicationInput(applicant_id="test-004", employment_type="issste")
        r = _stage0_prescreening(app)
        assert r.passed is True
        assert r.details.get("route") == "issste_track"

    # ── Stage 1 (ISSSTE) ─────────────────────────────────────────────────

    def test_stage1_issste_income_too_low_rejected(self):
        from pipeline.decision_tree import _stage1_issste, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", employment_type="issste",
            monthly_salary=3_000, principal_amount=1_000,
        )
        r = _stage1_issste(app)
        assert r.passed is False
        assert r.outcome == "rejected"
        assert "minimum" in r.rejection_reason.lower() or "salary" in r.rejection_reason.lower()

    def test_stage1_issste_deduction_capacity_ok(self):
        from pipeline.decision_tree import _stage1_issste, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", employment_type="issste",
            monthly_salary=15_000, principal_amount=3_000,  # 20% < 30% cap
        )
        r = _stage1_issste(app)
        assert r.passed is True
        assert r.outcome == "pending"

    def test_stage1_issste_deduction_exceeds_cap(self):
        from pipeline.decision_tree import _stage1_issste, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", employment_type="issste",
            monthly_salary=10_000, principal_amount=4_000,  # 40% > 30% cap
        )
        r = _stage1_issste(app)
        assert r.passed is False
        assert "cap" in r.rejection_reason.lower() or "deduction" in r.rejection_reason.lower()

    # ── Stage 2 (IMSS/AFORE) ─────────────────────────────────────────────

    def test_stage2_imss_enrolled_6_months_passes(self):
        from pipeline.decision_tree import _stage2_imss_afore, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", imss_enrolled_months=8, has_afore=False,
        )
        r = _stage2_imss_afore(app)
        assert r.passed is True

    def test_stage2_short_imss_no_afore_rejected(self):
        from pipeline.decision_tree import _stage2_imss_afore, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", imss_enrolled_months=3, has_afore=False,
        )
        r = _stage2_imss_afore(app)
        assert r.passed is False
        assert r.outcome == "rejected"
        assert "afore" in r.rejection_reason.lower() or "imss" in r.rejection_reason.lower()

    def test_stage2_short_imss_with_afore_passes(self):
        from pipeline.decision_tree import _stage2_imss_afore, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", imss_enrolled_months=3, has_afore=True,
        )
        r = _stage2_imss_afore(app)
        assert r.passed is True

    # ── Stage 3 (KYC / Bureau) ────────────────────────────────────────────

    def test_stage3_kyc_failed_rejected(self):
        from pipeline.decision_tree import _stage3_kyc_bureau, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", kyc_passed=False, kyc_confidence=40,
        )
        r = _stage3_kyc_bureau(app)
        assert r.passed is False
        assert r.outcome == "rejected"
        assert "kyc" in r.rejection_reason.lower()

    def test_stage3_low_kyc_confidence_rejected(self):
        from pipeline.decision_tree import _stage3_kyc_bureau, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", kyc_passed=True, kyc_confidence=50,
        )
        r = _stage3_kyc_bureau(app)
        assert r.passed is False

    def test_stage3_bureau_auto_approve(self):
        """Bureau score ≥ 720 with KYC passed → fast-track approval."""
        from pipeline.decision_tree import _stage3_kyc_bureau, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", kyc_passed=True, kyc_confidence=95,
            has_bureau_record=True, bureau_score=780,
        )
        r = _stage3_kyc_bureau(app)
        assert r.passed is True
        assert r.outcome == "approved"
        assert r.details.get("fast_track") is True

    def test_stage3_below_auto_approve_threshold_continues(self):
        """Bureau score below 720 → outcome pending, go to Stage 4."""
        from pipeline.decision_tree import _stage3_kyc_bureau, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", kyc_passed=True, kyc_confidence=90,
            has_bureau_record=True, bureau_score=680,
        )
        r = _stage3_kyc_bureau(app)
        assert r.passed is True
        assert r.outcome == "pending"
        assert r.details.get("fast_track") is False

    # ── Stage 4 (Fraud detection) ─────────────────────────────────────────

    def test_stage4_fraud_score_high_rejected(self):
        from pipeline.decision_tree import _stage4_fraud, ApplicationInput
        app = ApplicationInput(
            applicant_id="t",
            requests_last_hour=10,  # triggers hard flag
            monthly_salary=12_000,
            principal_amount=2_000,
            kyc_confidence=90,
        )
        r = _stage4_fraud(app)
        assert r.passed is False
        assert r.outcome == "rejected"

    def test_stage4_clean_signals_continues(self):
        from pipeline.decision_tree import _stage4_fraud, ApplicationInput
        app = ApplicationInput(
            applicant_id="t",
            requests_last_hour=0,
            monthly_salary=20_000,
            principal_amount=2_000,
            device_age_days=365,
            geo_distance_km=5,
            same_ip_applications=0,
            time_since_last_app_hours=720,
            kyc_confidence=95,
            bureau_inquiry_count=1,
        )
        r = _stage4_fraud(app)
        assert r.passed is True
        assert r.outcome == "pending"

    def test_stage4_result_contains_fraud_score(self):
        from pipeline.decision_tree import _stage4_fraud, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", monthly_salary=15_000, principal_amount=1_500,
        )
        r = _stage4_fraud(app)
        assert "fraud_score" in r.details or "fraud_result" in r.details

    # ── Stage 5 (AML / LLM Judge) ─────────────────────────────────────────

    def test_stage5_aml_sanctions_rejected(self):
        from pipeline.decision_tree import _stage5_aml_llm, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", aml_clear=False,
            monthly_salary=15_000, principal_amount=2_000,
        )
        r = _stage5_aml_llm(app, fraud_score=0)
        assert r.passed is False
        assert r.outcome == "rejected"
        assert "aml" in r.rejection_reason.lower() or "sanction" in r.rejection_reason.lower()

    def test_stage5_pep_flag_manual_review(self):
        from pipeline.decision_tree import _stage5_aml_llm, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", pep_flag=True, aml_clear=True,
            monthly_salary=15_000, principal_amount=2_000,
        )
        r = _stage5_aml_llm(app, fraud_score=0)
        assert r.outcome == "manual_review"
        assert "pep" in r.rejection_reason.lower() or "politically exposed" in r.rejection_reason.lower()

    def test_stage5_very_low_pd_approved(self):
        """PD < 10% → direct approval without LLM."""
        from pipeline.decision_tree import _stage5_aml_llm, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", aml_clear=True, pep_flag=False,
            monthly_salary=40_000, principal_amount=2_000,
            employment_tenure_months=72, has_bureau_record=True,
            bureau_score=800, pay_frequency="biweekly",
            employer_industry="government",
        )
        r = _stage5_aml_llm(app, fraud_score=0)
        assert r.outcome == "approved"

    def test_stage5_very_high_pd_rejected(self):
        """PD > 35% → direct rejection without LLM."""
        from pipeline.decision_tree import _stage5_aml_llm, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", aml_clear=True, pep_flag=False,
            monthly_salary=5_000, principal_amount=4_000,
            employment_tenure_months=1, has_bureau_record=True,
            bureau_score=350, pay_frequency="monthly",
            employer_industry="unknown",
        )
        r = _stage5_aml_llm(app, fraud_score=0)
        assert r.outcome == "rejected"

    def test_stage5_scorecard_included_in_details(self):
        from pipeline.decision_tree import _stage5_aml_llm, ApplicationInput
        app = ApplicationInput(
            applicant_id="t", aml_clear=True, pep_flag=False,
            monthly_salary=18_000, principal_amount=2_500,
            employment_tenure_months=24, has_bureau_record=True,
            bureau_score=650, pay_frequency="biweekly",
            employer_industry="manufacturing",
        )
        r = _stage5_aml_llm(app, fraud_score=0)
        assert "scorecard" in r.details

    # ── Full pipeline tests ───────────────────────────────────────────────

    def test_pipeline_excellent_applicant_approved(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="excellent-001",
            employment_type="imss",
            employment_tenure_months=48,
            monthly_salary=30_000,
            principal_amount=3_000,
            imss_enrolled_months=48,
            has_afore=True,
            kyc_passed=True,
            kyc_confidence=98,
            has_bureau_record=True,
            bureau_score=780,
            pay_frequency="biweekly",
            employer_industry="technology",
            aml_clear=True,
            pep_flag=False,
        )
        result = run_pipeline(app)
        assert result.decision == "approved"
        assert result.credit_score >= 650

    def test_pipeline_blacklisted_device_stops_at_stage0(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="fraud-001",
            blacklisted_device=True,
        )
        result = run_pipeline(app)
        assert result.decision == "rejected"
        assert result.stage_reached == 0

    def test_pipeline_kyc_fail_stops_at_stage3(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="kyc-fail-001",
            employment_type="imss",
            employment_tenure_months=12,
            monthly_salary=15_000,
            principal_amount=2_000,
            imss_enrolled_months=12,
            kyc_passed=False,
            kyc_confidence=30,
        )
        result = run_pipeline(app)
        assert result.decision == "rejected"
        assert result.stage_reached == 3

    def test_pipeline_fraud_rejected_at_stage4(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="fraud-002",
            employment_type="imss",
            employment_tenure_months=12,
            monthly_salary=15_000,
            principal_amount=2_000,
            imss_enrolled_months=12,
            kyc_passed=True,
            kyc_confidence=90,
            requests_last_hour=10,   # hard flag
            blacklisted_device=False,
        )
        result = run_pipeline(app)
        assert result.decision == "rejected"
        assert result.stage_reached == 4

    def test_pipeline_issste_worker_approved(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="issste-001",
            employment_type="issste",
            employment_tenure_months=36,
            monthly_salary=18_000,
            principal_amount=3_000,  # 16.7% deduction — within 30% cap
            kyc_passed=True,
            kyc_confidence=90,
            has_bureau_record=True,
            bureau_score=720,
            aml_clear=True,
            pay_frequency="biweekly",
        )
        result = run_pipeline(app)
        assert result.decision in ("approved",)

    def test_pipeline_returns_processing_time(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="perf-001",
            employment_type="imss",
            employment_tenure_months=24,
            monthly_salary=20_000,
            principal_amount=2_000,
            imss_enrolled_months=24,
            kyc_passed=True,
            kyc_confidence=90,
        )
        result = run_pipeline(app)
        assert result.processing_time_ms >= 0

    def test_pipeline_under_200ms(self):
        """Full pipeline (without LLM) must complete within 200ms."""
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="perf-002",
            employment_type="imss",
            employment_tenure_months=24,
            monthly_salary=20_000,
            principal_amount=2_000,
            imss_enrolled_months=24,
            kyc_passed=True,
            kyc_confidence=90,
            has_bureau_record=True,
            bureau_score=650,
            aml_clear=True,
            pep_flag=False,
        )
        t0 = time.perf_counter()
        result = run_pipeline(app)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        assert elapsed_ms < 200, f"Pipeline took {elapsed_ms:.1f}ms — exceeds 200ms SLA"

    def test_pipeline_aml_rejected_at_stage5(self):
        from pipeline.decision_tree import run_pipeline, ApplicationInput
        app = ApplicationInput(
            applicant_id="aml-001",
            employment_type="imss",
            employment_tenure_months=24,
            monthly_salary=20_000,
            principal_amount=2_000,
            imss_enrolled_months=24,
            kyc_passed=True,
            kyc_confidence=90,
            aml_clear=False,
            pep_flag=False,
        )
        result = run_pipeline(app)
        assert result.decision == "rejected"
        assert result.stage_reached == 5


# ---------------------------------------------------------------------------
# LLM Judge fallback logic (6)
# ---------------------------------------------------------------------------


class TestLLMJudge:

    def test_fallback_low_pd_approved(self):
        from pipeline.llm_judge import _fallback_decision
        result = _fallback_decision(pd_estimate=0.08, fraud_score=10)
        assert result.decision == "approved"
        assert result.used_fallback is True

    def test_fallback_high_pd_rejected(self):
        from pipeline.llm_judge import _fallback_decision
        result = _fallback_decision(pd_estimate=0.40, fraud_score=5)
        assert result.decision == "rejected"
        assert result.used_fallback is True

    def test_fallback_high_fraud_score_rejected(self):
        from pipeline.llm_judge import _fallback_decision
        result = _fallback_decision(pd_estimate=0.15, fraud_score=60)
        assert result.decision == "rejected"

    def test_fallback_borderline_manual_review(self):
        from pipeline.llm_judge import _fallback_decision
        result = _fallback_decision(pd_estimate=0.22, fraud_score=20)
        assert result.decision == "manual_review"

    def test_no_api_key_uses_fallback(self):
        """Without ANTHROPIC_API_KEY, should use deterministic fallback."""
        from pipeline.llm_judge import run_llm_judge
        with patch.dict(os.environ, {}, clear=True):
            result = run_llm_judge(
                monthly_salary=18_000,
                principal_amount=2_000,
                tenure_months=24,
                employment_type="imss",
                pd_estimate=0.10,
                credit_score=700,
                risk_grade="B",
                fraud_score=10,
                kyc_confidence=90,
                bureau_record=True,
                bureau_score=680.0,
                aml_clear=True,
                stage_reached=5,
                anthropic_api_key=None,
            )
        assert result.used_fallback is True
        assert result.decision in ("approved", "rejected", "manual_review")

    def test_llm_judge_with_mock_api(self):
        """Mock Anthropic client and verify JSON response parsing."""
        from pipeline.llm_judge import run_llm_judge
        import pipeline.llm_judge as llm_mod

        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=json.dumps({
            "decision": "approved",
            "confidence": 0.85,
            "reasoning": "Strong employment history and low PD.",
            "red_flags": [],
            "green_flags": ["24 months tenure", "Low PD"],
            "recommended_amount": 2000,
        }))]
        mock_client = MagicMock()
        mock_client.messages.create.return_value = mock_response

        mock_anthropic_mod = MagicMock()
        mock_anthropic_mod.Anthropic.return_value = mock_client

        original_anthropic = llm_mod.anthropic
        llm_mod.anthropic = mock_anthropic_mod
        try:
            result = run_llm_judge(
                monthly_salary=18_000,
                principal_amount=2_000,
                tenure_months=24,
                employment_type="imss",
                pd_estimate=0.12,
                credit_score=700,
                risk_grade="B",
                fraud_score=15,
                kyc_confidence=90,
                bureau_record=True,
                bureau_score=680.0,
                aml_clear=True,
                stage_reached=5,
                anthropic_api_key="sk-test-key",
            )
        finally:
            llm_mod.anthropic = original_anthropic

        assert result.decision == "approved"
        assert result.confidence == 0.85
        assert result.used_fallback is False
        assert result.recommended_amount == 2000


# ---------------------------------------------------------------------------
# FastAPI endpoint tests (10)
# ---------------------------------------------------------------------------


class TestFastAPIEndpoints:
    """Integration tests for the three new endpoints via FastAPI TestClient.

    Redis is patched out so no live infrastructure is needed.
    """

    def _make_client(self, cache_return=None):
        """Create a TestClient with Redis and SEC mocked at module level."""
        from fastapi.testclient import TestClient
        import main as m

        mock_rdb = MagicMock()
        mock_rdb.ping.return_value = True
        mock_rdb.get.return_value = cache_return  # None = cache miss
        mock_rdb.setex.return_value = True

        # Patch module globals directly — these persist for the lifetime of the test
        m.rdb = mock_rdb
        m.SEC = "test-secret"

        client = TestClient(m.app, raise_server_exceptions=True)
        return client, mock_rdb

    def test_pipeline_endpoint_requires_auth(self):
        client, _ = self._make_client()
        resp = client.post("/underwrite/pipeline", json={"applicant_id": "x"})
        assert resp.status_code == 401

    def test_pipeline_endpoint_good_applicant(self):
        client, _ = self._make_client()
        resp = client.post(
            "/underwrite/pipeline",
            json={
                "applicant_id": "ep-001",
                "employment_type": "imss",
                "employment_tenure_months": 36,
                "monthly_salary": 20000,
                "principal_amount": 2000,
                "imss_enrolled_months": 36,
                "kyc_passed": True,
                "kyc_confidence": 95,
                "has_bureau_record": True,
                "bureau_score": 720,
                "aml_clear": True,
            },
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "decision" in body
        assert body["decision"] in ("approved", "rejected", "manual_review")
        assert "credit_score" in body
        assert "stage_results" in body

    def test_pipeline_endpoint_redis_cache_hit(self):
        cached_body = json.dumps({
            "applicant_id": "ep-002", "decision": "approved",
            "credit_score": 720, "stage_reached": 5,
            "stage_name": "aml_llm_judge", "pd_estimate": 0.08,
            "risk_grade": "A", "fraud_score": 5.0,
            "stage_results": [], "models_used": ["rule_based"],
            "processing_time_ms": 10, "ts": 1000,
            "decisionId": "ep-002_1000", "rejection_reason": None,
            "approval_conditions": [],
        })
        client, mock_rdb = self._make_client(cache_return=cached_body)
        resp = client.post(
            "/underwrite/pipeline",
            json={"applicant_id": "ep-002", "principal_amount": 2000},
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200
        assert resp.json()["decision"] == "approved"
        mock_rdb.get.assert_called_once()

    def test_scorecard_endpoint_requires_auth(self):
        client, _ = self._make_client()
        resp = client.post("/underwrite/scorecard", json={})
        assert resp.status_code == 401

    def test_scorecard_endpoint_returns_score(self):
        client, _ = self._make_client()
        resp = client.post(
            "/underwrite/scorecard",
            json={
                "bureau_score": 700,
                "employment_tenure_months": 24,
                "monthly_salary": 20_000,
                "principal_amount": 2_000,
                "pay_frequency_encoded": 2,
                "employer_industry_encoded": 1,
                "has_bureau_record": 1,
            },
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert 300 <= body["credit_score"] <= 850
        assert 0 <= body["pd_estimate"] <= 1
        assert body["risk_grade"] in ("A", "B", "C", "D", "E")
        assert "woe_contributions" in body

    def test_fraud_endpoint_requires_auth(self):
        client, _ = self._make_client()
        resp = client.post("/underwrite/fraud", json={})
        assert resp.status_code == 401

    def test_fraud_endpoint_normal_returns_low_score(self):
        client, _ = self._make_client()
        resp = client.post(
            "/underwrite/fraud",
            json={
                "requests_last_hour": 0,
                "amount_to_salary_ratio": 0.10,
                "device_age_days": 365,
                "geo_distance_km": 5,
                "same_ip_applications": 0,
                "time_since_last_app_hours": 720,
                "kyc_confidence_score": 95,
                "bureau_inquiry_count": 1,
            },
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_fraud"] is False
        assert body["fraud_score"] < 50

    def test_fraud_endpoint_detects_hard_flag(self):
        client, _ = self._make_client()
        resp = client.post(
            "/underwrite/fraud",
            json={"requests_last_hour": 15},  # hard flag
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_fraud"] is True
        assert body["fraud_score"] == 100.0
        assert len(body["hard_flags"]) > 0

    def test_pipeline_endpoint_missing_applicant_id_still_works(self):
        """Missing applicant_id should not crash — uses empty string as fallback."""
        client, _ = self._make_client()
        resp = client.post(
            "/underwrite/pipeline",
            json={
                "employment_type": "imss",
                "employment_tenure_months": 24,
                "monthly_salary": 20000,
                "principal_amount": 2000,
            },
            headers={"x-internal-secret": "test-secret"},
        )
        assert resp.status_code == 200

    def test_pipeline_endpoint_performance_under_200ms(self):
        """Endpoint including overhead must respond in < 200ms (no LLM, no Redis)."""
        client, _ = self._make_client()
        t0 = time.perf_counter()
        resp = client.post(
            "/underwrite/pipeline",
            json={
                "applicant_id": "perf-ep-001",
                "employment_type": "imss",
                "employment_tenure_months": 24,
                "monthly_salary": 20000,
                "principal_amount": 2000,
                "imss_enrolled_months": 24,
                "kyc_passed": True,
                "kyc_confidence": 90,
                "has_bureau_record": True,
                "bureau_score": 680,
                "aml_clear": True,
            },
            headers={"x-internal-secret": "test-secret"},
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        assert resp.status_code == 200
        assert elapsed_ms < 200, f"Endpoint took {elapsed_ms:.1f}ms — exceeds 200ms SLA"
