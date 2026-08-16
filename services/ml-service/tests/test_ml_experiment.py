import json

import pandas as pd
import pytest

from pipelines.ml_experiment import (
    FEATURES,
    approval_gate,
    drift_report,
    population_stability_index,
    prepare_features,
    reference_data,
    run_experiment,
)


def test_reference_data_is_deterministic():
    pd.testing.assert_frame_equal(reference_data(120, 7), reference_data(120, 7))


def test_boundary_validation_rejects_missing_and_non_binary_target():
    with pytest.raises(ValueError, match="missing required"):
        prepare_features(reference_data(100).drop(columns=[FEATURES[0]]))
    frame = reference_data(100)
    frame["repaid"] = 2
    with pytest.raises(ValueError, match="only 0 or 1"):
        prepare_features(frame)


def test_gate_fails_closed_on_weak_model_or_drift():
    assert not approval_gate({"champion": {"auc": 0.59}}, {"max_psi": 0.01})["approved"]
    assert not approval_gate({"champion": {"auc": 0.9}}, {"max_psi": 0.26})["approved"]


def test_pipeline_exports_candidate_artifacts_with_shadow_authority(tmp_path):
    manifest = run_experiment(tmp_path, rows=200, seed=11)
    assert manifest["authority"] == "shadow_only"
    assert set(manifest["artifact_sha256"]) == {"champion", "challenger"}
    assert json.loads((tmp_path / "manifest.json").read_text())["schema"] == 1


def test_psi_is_zero_for_identical_population():
    values = pd.Series([1.0, 2.0, 3.0, 4.0])
    assert population_stability_index(values, values) == pytest.approx(0.0)


def test_drift_report_covers_all_features():
    frame = reference_data(100)
    report = drift_report(frame, frame.copy())
    assert set(report["features"]) == set(FEATURES)
