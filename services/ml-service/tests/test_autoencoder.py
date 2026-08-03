"""
Tests for the MetaMap autoencoder anomaly detection (Stage 4).

Validates:
  - Autoencoder input/output dimension = 7
  - Model loads from saved artifact
  - Known-fraud inputs produce high reconstruction error
  - Known-legitimate inputs produce low reconstruction error
  - parse_device_signals extracts correct 7 features
  - device_fraud_score integrates rules + autoencoder
"""

import os
import sys

import pytest
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.autoencoder import (
    AnomalyDetector,
    MetaMapAutoencoder,
    FEATURE_NAMES,
    INPUT_DIM,
    normalize_features,
)
from scoring import parse_device_signals, device_fraud_score

# ── Architecture tests ───────────────────────────────────────────────────────


def test_input_output_dimension_is_7():
    model = MetaMapAutoencoder()
    assert INPUT_DIM == 7
    # Verify first encoder layer accepts 7 inputs
    assert model.encoder[0].in_features == 7
    # Verify last decoder layer outputs 7
    assert model.decoder[-2].out_features == 7


def test_hidden_layers_4_2_4():
    model = MetaMapAutoencoder()
    # Encoder: 7→4, 4→2
    assert model.encoder[0].out_features == 4
    assert model.encoder[2].out_features == 2
    # Decoder: 2→4, 4→7
    assert model.decoder[0].out_features == 4
    assert model.decoder[2].out_features == 7


def test_forward_pass_shape():
    model = MetaMapAutoencoder()
    x = torch.randn(5, 7)
    out = model(x)
    assert out.shape == (5, 7)


def test_feature_names_count():
    assert len(FEATURE_NAMES) == 7


# ── Normalization tests ──────────────────────────────────────────────────────


def test_normalize_features_range():
    raw = {
        "emulator_detected": 1,
        "vpn_detected": 0,
        "rooted_device": 1,
        "device_age_days": 1825,
        "ip_reputation_score": 50,
        "session_duration_seconds": 1800,
        "interaction_anomaly_score": 50,
    }
    normed = normalize_features(raw)
    assert normed.shape == (7,)
    assert all(0.0 <= v <= 1.0 for v in normed)


def test_normalize_features_clamps():
    raw = {
        "device_age_days": 99999,  # above max
        "ip_reputation_score": -10,  # below min
    }
    normed = normalize_features(raw)
    assert all(0.0 <= v <= 1.0 for v in normed)


# ── Model load/save tests ───────────────────────────────────────────────────


MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "..", "models", "autoencoder_v2_metamap.pt"
)


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
def test_model_loads():
    detector = AnomalyDetector.load(MODEL_PATH)
    assert detector.model is not None
    assert detector.threshold > 0


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
def test_model_save_load_roundtrip(tmp_path):
    original = AnomalyDetector.load(MODEL_PATH)
    save_path = str(tmp_path / "test_model.pt")
    original.save(save_path)

    loaded = AnomalyDetector.load(save_path)
    assert abs(loaded.threshold - original.threshold) < 1e-6


# ── Fraud detection tests ───────────────────────────────────────────────────


KNOWN_FRAUD_INPUTS = [
    {
        "emulator_detected": 1.0,
        "vpn_detected": 1.0,
        "rooted_device": 1.0,
        "device_age_days": 2,
        "ip_reputation_score": 5,
        "session_duration_seconds": 15,
        "interaction_anomaly_score": 95,
    },
    {
        "emulator_detected": 1.0,
        "vpn_detected": 0.0,
        "rooted_device": 1.0,
        "device_age_days": 0,
        "ip_reputation_score": 10,
        "session_duration_seconds": 8,
        "interaction_anomaly_score": 88,
    },
    {
        "emulator_detected": 0.0,
        "vpn_detected": 1.0,
        "rooted_device": 0.0,
        "device_age_days": 3,
        "ip_reputation_score": 2,
        "session_duration_seconds": 20,
        "interaction_anomaly_score": 92,
    },
]

KNOWN_LEGIT_INPUTS = [
    {
        "emulator_detected": 0.0,
        "vpn_detected": 0.0,
        "rooted_device": 0.0,
        "device_age_days": 500,
        "ip_reputation_score": 85,
        "session_duration_seconds": 600,
        "interaction_anomaly_score": 10,
    },
    {
        "emulator_detected": 0.0,
        "vpn_detected": 0.0,
        "rooted_device": 0.0,
        "device_age_days": 1200,
        "ip_reputation_score": 92,
        "session_duration_seconds": 450,
        "interaction_anomaly_score": 5,
    },
]


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
class TestFraudDetection:
    def setup_method(self):
        self.detector = AnomalyDetector.load(MODEL_PATH)

    def test_fraud_inputs_produce_high_reconstruction_error(self):
        for i, fraud_input in enumerate(KNOWN_FRAUD_INPUTS):
            result = self.detector.predict(fraud_input)
            assert result["is_anomaly"], (
                f"Fraud input #{i} was NOT flagged as anomaly "
                f"(error={result['reconstruction_error']}, "
                f"threshold={result['threshold']})"
            )
            assert result["reconstruction_error"] > result["threshold"]

    def test_legit_inputs_produce_low_reconstruction_error(self):
        for i, legit_input in enumerate(KNOWN_LEGIT_INPUTS):
            result = self.detector.predict(legit_input)
            assert not result["is_anomaly"], (
                f"Legit input #{i} was falsely flagged as anomaly "
                f"(error={result['reconstruction_error']}, "
                f"threshold={result['threshold']})"
            )
            assert result["reconstruction_error"] < result["threshold"]

    def test_fraud_error_exceeds_legit_error(self):
        fraud_errors = [
            self.detector.predict(f)["reconstruction_error"] for f in KNOWN_FRAUD_INPUTS
        ]
        legit_errors = [
            self.detector.predict(legit)["reconstruction_error"]
            for legit in KNOWN_LEGIT_INPUTS
        ]
        assert min(fraud_errors) > max(legit_errors), (
            f"Fraud min error ({min(fraud_errors):.6f}) should exceed "
            f"legit max error ({max(legit_errors):.6f})"
        )


# ── parse_device_signals tests ───────────────────────────────────────────────


def test_parse_device_signals_flat():
    raw = {
        "emulator_detected": True,
        "vpn_detected": False,
        "rooted_device": True,
        "device_age_days": 100,
        "ip_reputation_score": 75.5,
        "session_duration_seconds": 300,
        "interaction_anomaly_score": 20,
    }
    parsed = parse_device_signals(raw)
    assert len(parsed) == 7
    assert parsed["emulator_detected"] == 1.0
    assert parsed["vpn_detected"] == 0.0
    assert parsed["device_age_days"] == 100.0


def test_parse_device_signals_nested():
    raw = {
        "deviceSignals": {
            "emulator_detected": 0,
            "vpn_detected": 1,
            "rooted_device": 0,
            "device_age_days": 200,
            "ip_reputation_score": 60,
            "session_duration_seconds": 500,
            "interaction_anomaly_score": 15,
        }
    }
    parsed = parse_device_signals(raw)
    assert len(parsed) == 7
    assert parsed["vpn_detected"] == 1.0


def test_parse_device_signals_defaults():
    parsed = parse_device_signals({})
    assert len(parsed) == 7
    assert parsed["emulator_detected"] == 0.0
    assert parsed["ip_reputation_score"] == 50.0  # default for missing


# ── device_fraud_score integration tests ─────────────────────────────────────


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
def test_device_fraud_score_flags_fraud():
    payload = {
        "requestsLastHour": 0,
        "amountToSalaryRatio": 0.1,
        "deviceSignals": KNOWN_FRAUD_INPUTS[0],
    }
    result = device_fraud_score(payload)
    assert result["is_fraud"] is True
    assert result["autoencoder"]["is_anomaly"] is True
    assert len(result["device_signals"]) == 7


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
def test_device_fraud_score_passes_legit():
    payload = {
        "requestsLastHour": 0,
        "amountToSalaryRatio": 0.1,
        "deviceSignals": KNOWN_LEGIT_INPUTS[0],
    }
    result = device_fraud_score(payload)
    assert result["is_fraud"] is False
    assert result["autoencoder"]["is_anomaly"] is False


@pytest.mark.skipif(
    not os.path.exists(MODEL_PATH),
    reason="Model artifact not found — run train_autoencoder.py first",
)
def test_device_fraud_score_rules_override():
    """Rule-based fraud (high request rate) should flag even with legit device signals."""
    payload = {
        "requestsLastHour": 5,
        "amountToSalaryRatio": 0.1,
        "deviceSignals": KNOWN_LEGIT_INPUTS[0],
    }
    result = device_fraud_score(payload)
    assert result["is_fraud"] is True  # rules triggered
    assert result["autoencoder"]["is_anomaly"] is False  # but AE says legit
