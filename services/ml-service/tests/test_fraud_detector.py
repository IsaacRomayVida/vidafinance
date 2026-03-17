"""Tests for Isolation Forest fraud detector."""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fraud_detector import detect, FEATURE_ORDER


class TestFraudDetect:
    def test_normal_application(self):
        result = detect({
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.20,
            "device_risk_score": 10,
            "behavioral_risk_score": 10,
            "hour_of_day": 14,
            "days_since_account_created": 180,
            "ip_country_mismatch": 0,
            "bureau_inquiries_90d": 1,
        })
        assert result.anomaly_score < 65
        assert result.is_fraud is False
        assert result.model == "isolation_forest_v1"

    def test_high_velocity_hard_flag(self):
        result = detect({"requests_last_hour": 10})
        assert "requests_last_hour" in result.hard_flags
        assert result.is_fraud is True

    def test_device_risk_hard_flag(self):
        result = detect({"device_risk_score": 90})
        assert "device_risk_score" in result.hard_flags
        assert result.is_fraud is True

    def test_ip_mismatch_hard_flag(self):
        result = detect({"ip_country_mismatch": 1})
        assert "ip_country_mismatch" in result.hard_flags

    def test_missing_features_imputed(self):
        result = detect({})
        assert 0 <= result.anomaly_score <= 100
        assert isinstance(result.is_fraud, bool)

    def test_feature_contributions(self):
        result = detect({
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.20,
        })
        assert isinstance(result.feature_contributions, dict)
        for feat in FEATURE_ORDER:
            assert feat in result.feature_contributions

    def test_multiple_hard_flags(self):
        result = detect({
            "requests_last_hour": 10,
            "device_risk_score": 95,
            "amount_to_salary_ratio": 0.50,
            "behavioral_risk_score": 85,
        })
        assert len(result.hard_flags) >= 3
        assert result.is_fraud is True

    def test_score_bounds(self):
        result = detect({
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.10,
        })
        assert 0 <= result.anomaly_score <= 100
