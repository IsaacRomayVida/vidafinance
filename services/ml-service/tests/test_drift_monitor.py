"""
Tests for PSI/CSI drift monitoring.

Covers:
  - PSI calculation correctness
  - CSI per-feature calculation
  - Baseline generation and loading
  - Full drift check pipeline
  - Alert threshold classification
"""

import json
import os
import sys
import tempfile

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.drift_monitor import (
    FEATURE_NAMES,
    PSI_RETRAIN_THRESHOLD,
    PSI_WARNING_THRESHOLD,
    classify_drift,
    compute_csi,
    compute_psi,
    generate_baseline_from_data,
    load_baseline,
    run_drift_check,
    save_baseline,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def rng():
    return np.random.default_rng(42)


@pytest.fixture
def synthetic_data(rng):
    """Generate synthetic feature matrix and scores."""
    n = 500
    X = np.column_stack([
        rng.exponential(scale=18, size=n).clip(0, 120),       # tenure
        rng.lognormal(mean=9.7, sigma=0.5, size=n).clip(7000, 40000),  # salary
        rng.choice([1, 2, 4], size=n).astype(float),          # pay_freq
        rng.uniform(0.01, 0.5, size=n),                       # lts_ratio
        rng.choice(range(9), size=n).astype(float),            # industry
        rng.uniform(500, 5000, size=n),                        # principal
        rng.uniform(300, 800, size=n),                         # bureau
        rng.choice([0, 1], size=n).astype(float),              # has_bureau
    ])
    scores = rng.uniform(0, 1, size=n)
    return X, scores


@pytest.fixture
def baseline(synthetic_data):
    X, scores = synthetic_data
    return generate_baseline_from_data(X, scores)


# ── PSI tests ─────────────────────────────────────────────────────────────────

def test_psi_identical_distributions():
    """PSI of a distribution compared to itself should be ~0."""
    rng = np.random.default_rng(99)
    data = rng.normal(0, 1, size=1000)
    psi = compute_psi(data, data)
    assert psi < 0.01, f"PSI of identical distributions should be ~0, got {psi}"


def test_psi_similar_distributions():
    """PSI of slightly shifted distributions should be small."""
    rng = np.random.default_rng(99)
    expected = rng.normal(0, 1, size=1000)
    actual = rng.normal(0.05, 1, size=1000)  # tiny shift
    psi = compute_psi(expected, actual)
    assert psi < PSI_WARNING_THRESHOLD, f"Small shift should give PSI < 0.10, got {psi}"


def test_psi_different_distributions():
    """PSI of very different distributions should be large."""
    rng = np.random.default_rng(99)
    expected = rng.normal(0, 1, size=1000)
    actual = rng.normal(5, 1, size=1000)  # large shift
    psi = compute_psi(expected, actual)
    assert psi > PSI_RETRAIN_THRESHOLD, f"Large shift should give PSI > 0.25, got {psi}"


def test_psi_non_negative():
    """PSI should always be non-negative."""
    rng = np.random.default_rng(42)
    for _ in range(10):
        a = rng.normal(rng.uniform(-5, 5), rng.uniform(0.5, 3), size=200)
        b = rng.normal(rng.uniform(-5, 5), rng.uniform(0.5, 3), size=200)
        psi = compute_psi(a, b)
        assert psi >= 0, f"PSI must be non-negative, got {psi}"


# ── CSI tests ─────────────────────────────────────────────────────────────────

def test_csi_identical_feature(baseline, synthetic_data):
    """CSI of a feature compared to its own baseline should be ~0."""
    X, _ = synthetic_data
    for i, name in enumerate(FEATURE_NAMES):
        csi_result = compute_csi(baseline["features"][name], X[:, i])
        assert csi_result["csi"] < 0.05, (
            f"CSI for {name} against own baseline should be ~0, got {csi_result['csi']}"
        )
        assert "baseline_mean" in csi_result
        assert "current_mean" in csi_result


def test_csi_shifted_feature(baseline):
    """CSI should increase when feature distribution shifts."""
    rng = np.random.default_rng(42)

    # salary feature (index 1) — shift mean from ~18k to ~30k
    shifted = rng.lognormal(mean=10.3, sigma=0.3, size=500).clip(7000, 40000)
    csi_result = compute_csi(baseline["features"]["monthly_salary"], shifted)
    assert csi_result["csi"] > 0.05, (
        f"Shifted salary distribution should have CSI > 0.05, got {csi_result['csi']}"
    )


# ── Classification tests ─────────────────────────────────────────────────────

def test_classify_drift_stable():
    assert classify_drift(0.05) == "stable"
    assert classify_drift(0.0) == "stable"
    assert classify_drift(0.09) == "stable"


def test_classify_drift_warning():
    assert classify_drift(0.11) == "warning"
    assert classify_drift(0.20) == "warning"
    assert classify_drift(0.24) == "warning"


def test_classify_drift_retrain():
    assert classify_drift(0.26) == "retrain"
    assert classify_drift(0.50) == "retrain"
    assert classify_drift(1.0) == "retrain"


# ── Baseline save/load tests ─────────────────────────────────────────────────

def test_baseline_roundtrip(baseline):
    """Baseline should survive save → load roundtrip."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name

    try:
        save_baseline(baseline, path)
        loaded = load_baseline(path)

        assert loaded["model_version"] == "logistic_v1.0"
        assert loaded["n_features"] == 8
        assert loaded["n_samples"] == 500
        assert set(loaded["feature_names"]) == set(FEATURE_NAMES)

        for name in FEATURE_NAMES:
            assert name in loaded["features"]
            feat = loaded["features"][name]
            assert "mean" in feat
            assert "std" in feat
            assert "histogram" in feat
            assert len(feat["percentiles"]) == 5

        assert "score_distribution" in loaded
        assert "histogram" in loaded["score_distribution"]
    finally:
        os.unlink(path)


def test_baseline_file_exists():
    """The generated v1_baseline.json should exist."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "models", "baselines", "v1_baseline.json"
    )
    assert os.path.exists(path), f"Baseline file not found at {path}"

    with open(path) as f:
        data = json.load(f)

    assert data["model_version"] == "logistic_v1.0"
    assert data["n_samples"] == 5000
    assert len(data["features"]) == 8


# ── Full drift check tests ───────────────────────────────────────────────────

def test_run_drift_check_stable(baseline, synthetic_data):
    """Drift check against own training data should show stable."""
    X, scores = synthetic_data
    report = run_drift_check(X, scores, baseline)

    assert report["alert_level"] == "stable"
    assert report["score_psi"] < PSI_WARNING_THRESHOLD
    assert report["model_version"] == "logistic_v1.0"
    assert report["current_samples"] == 500
    assert len(report["feature_csi"]) == 8

    for name in FEATURE_NAMES:
        assert name in report["feature_csi"]
        assert "csi" in report["feature_csi"][name]


def test_run_drift_check_with_shift(baseline):
    """Drift check with shifted data should detect drift."""
    rng = np.random.default_rng(123)
    n = 500
    # Shift most features significantly
    X_shifted = np.column_stack([
        rng.exponential(scale=50, size=n).clip(0, 120),       # much higher tenure
        rng.lognormal(mean=10.2, sigma=0.3, size=n).clip(7000, 40000),  # higher salary
        np.full(n, 4.0),                                       # all weekly
        rng.uniform(0.3, 0.8, size=n),                         # much higher ratios
        np.full(n, 8.0),                                       # single industry
        rng.uniform(3000, 5000, size=n),                        # higher principals
        rng.uniform(600, 800, size=n),                          # higher bureau
        np.ones(n),                                             # all have bureau
    ])
    scores_shifted = rng.uniform(0.7, 1.0, size=n)  # much higher scores

    report = run_drift_check(X_shifted, scores_shifted, baseline)
    assert report["alert_level"] in ("warning", "retrain")
    assert report["score_psi"] > PSI_WARNING_THRESHOLD


# ── Baseline generation tests ────────────────────────────────────────────────

def test_generate_baseline_structure(synthetic_data):
    """Generated baseline should have all required fields."""
    X, scores = synthetic_data
    baseline = generate_baseline_from_data(X, scores)

    assert baseline["model_version"] == "logistic_v1.0"
    assert baseline["n_samples"] == 500
    assert baseline["n_features"] == 8
    assert len(baseline["feature_names"]) == 8

    assert "thresholds" in baseline
    assert baseline["thresholds"]["psi_warning"] == 0.10
    assert baseline["thresholds"]["psi_retrain"] == 0.25

    for name in FEATURE_NAMES:
        feat = baseline["features"][name]
        assert all(k in feat for k in ["mean", "std", "min", "max", "percentiles", "histogram"])
        assert len(feat["histogram"]["counts"]) == 10
        assert len(feat["histogram"]["bin_edges"]) == 11

    score = baseline["score_distribution"]
    assert all(k in score for k in ["mean", "std", "min", "max", "percentiles", "histogram"])
