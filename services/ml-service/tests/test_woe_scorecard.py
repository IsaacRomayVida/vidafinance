"""Tests for WoE logistic regression scorecard."""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from woe_scorecard import score, _lookup_woe, _pd_to_score, _risk_grade, WOE_TABLES


class TestWoELookup:
    def test_bureau_score_low(self):
        woe = _lookup_woe(WOE_TABLES["bureau_score"], 350)
        assert woe == -0.85

    def test_bureau_score_mid(self):
        woe = _lookup_woe(WOE_TABLES["bureau_score"], 550)
        assert woe == -0.05

    def test_bureau_score_high(self):
        woe = _lookup_woe(WOE_TABLES["bureau_score"], 750)
        assert woe == 0.70

    def test_bureau_score_excellent(self):
        woe = _lookup_woe(WOE_TABLES["bureau_score"], 850)
        assert woe == 1.00

    def test_dias_atraso_current(self):
        woe = _lookup_woe(WOE_TABLES["dias_atraso"], 0)
        assert woe == 0.60

    def test_dias_atraso_severe(self):
        woe = _lookup_woe(WOE_TABLES["dias_atraso"], 100)
        assert woe == -1.20


class TestPDToScore:
    def test_low_pd(self):
        s = _pd_to_score(0.02)
        assert 700 <= s <= 850

    def test_high_pd(self):
        s = _pd_to_score(0.50)
        assert 300 <= s <= 600

    def test_bounds(self):
        assert _pd_to_score(0.001) <= 850
        assert _pd_to_score(0.99) >= 300


class TestRiskGrade:
    def test_grade_a(self):
        assert _risk_grade(780) == "A"

    def test_grade_b(self):
        assert _risk_grade(700) == "B"

    def test_grade_c(self):
        assert _risk_grade(620) == "C"

    def test_grade_d(self):
        assert _risk_grade(520) == "D"

    def test_grade_e(self):
        assert _risk_grade(400) == "E"


class TestScorecard:
    def test_good_applicant(self):
        result = score({
            "bureau_score": 720,
            "dias_atraso": 0,
            "monthly_salary_mxn": 25000,
            "employer_tier": 1,
            "existing_loans": 0,
            "tenure_months": 36,
            "afore_balance_mxn": 80000,
            "amount_to_salary_ratio": 0.15,
        })
        assert result.pd < 0.05
        assert result.credit_score >= 750
        assert result.risk_grade == "A"
        assert result.recommended_limit_mxn > 0
        assert result.model == "woe_logistic_v1"

    def test_risky_applicant(self):
        result = score({
            "bureau_score": 380,
            "dias_atraso": 45,
            "monthly_salary_mxn": 7000,
            "employer_tier": 3,
            "existing_loans": 2,
            "tenure_months": 4,
            "afore_balance_mxn": 0,
            "amount_to_salary_ratio": 0.35,
        })
        assert result.pd > 0.50
        assert result.credit_score < 600
        assert result.risk_grade in ("D", "E")

    def test_missing_features_graceful(self):
        result = score({})
        assert 300 <= result.credit_score <= 850
        assert 0 <= result.pd <= 1
        assert result.risk_grade in ("A", "B", "C", "D", "E")

    def test_limit_cap_5000(self):
        result = score({"monthly_salary_mxn": 100000})
        assert result.recommended_limit_mxn <= 5000

    def test_woe_contributions_present(self):
        result = score({"bureau_score": 600, "dias_atraso": 0})
        assert "bureau_score" in result.woe_contributions
        assert "dias_atraso" in result.woe_contributions
