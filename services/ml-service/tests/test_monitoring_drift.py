"""
Tests for monitoring/drift.py's evidently integration.

Regression guard for #463: the docstring claimed a per-column
DataDriftPreset report while the code only ran DatasetDriftMetric (and
imported DataDriftPreset/ColumnDriftMetric without using either). This
verifies run_drift_check now actually returns per-column drift detail.
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from monitoring.drift import FEATURE_COLUMNS, SCORE_COLUMN, run_drift_check


@pytest.fixture
def frames():
    rng = np.random.default_rng(7)
    n = 60

    def make(loc=0.0):
        data = {col: rng.normal(loc, 1, size=n) for col in FEATURE_COLUMNS}
        data[SCORE_COLUMN] = rng.uniform(0, 1, size=n)
        return pd.DataFrame(data)

    return make(0.0), make(0.0)


def test_run_drift_check_reports_per_column_drift(frames):
    reference_df, current_df = frames
    results = run_drift_check(reference_df, current_df)

    assert "evidently_drift" in results
    assert "error" not in results["evidently_drift"]
    columns = results["evidently_drift"]["columns"]

    for col in FEATURE_COLUMNS:
        assert col in columns
        assert "drift_score" in columns[col]
        assert "drift_detected" in columns[col]
