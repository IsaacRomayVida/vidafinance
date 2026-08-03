"""
Tests for the Stage 0 Isolation Forest fraud pre-screen.
"""

import numpy as np
import pytest

from models.isolation_forest import FraudPreScreen, FEATURE_NAMES


@pytest.fixture
def trained_model():
    """Train a small Isolation Forest for testing."""
    rng = np.random.RandomState(42)
    # Generate 500 legitimate samples
    X = np.column_stack(
        [
            rng.poisson(0.5, 500).astype(float),
            rng.uniform(0.05, 0.30, 500),
            rng.uniform(30, 3650, 500),
            rng.uniform(60, 100, 500),
            rng.uniform(60, 1200, 500),
            rng.uniform(0, 20, 500),
            rng.poisson(1.5, 500).astype(float),
            rng.choice([1, 2], 500, p=[0.85, 0.15]).astype(float),
        ]
    )
    return FraudPreScreen.train(X, contamination=0.05, n_estimators=50)


class TestFraudPreScreen:
    def test_train_creates_model(self, trained_model):
        assert trained_model.model is not None
        assert trained_model.version == "isolation_forest_v1.0"
        assert len(trained_model.feature_names) == 8

    def test_legitimate_application_passes(self, trained_model):
        legit = {
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.15,
            "device_age_days": 500,
            "ip_reputation_score": 85,
            "session_duration_seconds": 300,
            "interaction_anomaly_score": 5,
            "bureau_inquiries_last_30d": 1,
            "distinct_ips_last_24h": 1,
        }
        result = trained_model.predict(legit)
        assert result["is_fraud"] is False
        assert "anomaly_score" in result
        assert "threshold" in result

    def test_fraudulent_application_flagged(self, trained_model):
        fraud = {
            "requests_last_hour": 15,
            "amount_to_salary_ratio": 0.80,
            "device_age_days": 2,
            "ip_reputation_score": 5,
            "session_duration_seconds": 10,
            "interaction_anomaly_score": 90,
            "bureau_inquiries_last_30d": 12,
            "distinct_ips_last_24h": 6,
        }
        result = trained_model.predict(fraud)
        assert result["is_fraud"] is True

    def test_batch_prediction(self, trained_model):
        batch = [
            {f: 0.0 for f in FEATURE_NAMES},
            {f: 100.0 for f in FEATURE_NAMES},
        ]
        results = trained_model.predict_batch(batch)
        assert len(results) == 2
        for r in results:
            assert "anomaly_score" in r
            assert "is_fraud" in r

    def test_anomaly_score_is_float(self, trained_model):
        features = {f: 1.0 for f in FEATURE_NAMES}
        result = trained_model.predict(features)
        assert isinstance(result["anomaly_score"], float)

    def test_save_and_load(self, trained_model, tmp_path):
        path = str(tmp_path / "test_if.joblib")
        trained_model.save(path)
        loaded = FraudPreScreen.load(path)
        assert loaded.version == trained_model.version
        assert loaded.threshold == trained_model.threshold

        # Same prediction from loaded model
        features = {
            "requests_last_hour": 0,
            "amount_to_salary_ratio": 0.15,
            "device_age_days": 500,
            "ip_reputation_score": 85,
            "session_duration_seconds": 300,
            "interaction_anomaly_score": 5,
            "bureau_inquiries_last_30d": 1,
            "distinct_ips_last_24h": 1,
        }
        original = trained_model.predict(features)
        loaded_result = loaded.predict(features)
        assert abs(original["anomaly_score"] - loaded_result["anomaly_score"]) < 1e-6

    def test_missing_features_default_to_zero(self, trained_model):
        result = trained_model.predict({})
        assert "anomaly_score" in result
