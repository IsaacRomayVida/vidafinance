"""
Tests for workers/drift_scheduler.py feature extraction.

Regression guard for #463: a feature absent from every loan's
`underwritingFeatures` used to be silently defaulted to 0.0 and scored as
"stable" drift. It must instead be dropped from the columns handed to CSI
and reported as unmonitored.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.drift_monitor import FEATURE_NAMES
from workers.drift_scheduler import _extract_features_and_scores


def _loan(score, **uw_features):
    return {"underwritingScore": score, "underwritingFeatures": uw_features}


def test_extract_drops_feature_absent_from_every_loan():
    present = {name: 1.0 for name in FEATURE_NAMES if name != "employer_industry_encoded"}
    loans = [_loan(0.5, **present), _loan(0.6, **present)]

    features, scores, available = _extract_features_and_scores(loans)

    assert "employer_industry_encoded" not in available
    assert set(available) == set(FEATURE_NAMES) - {"employer_industry_encoded"}
    assert features.shape == (2, len(available))
    assert len(scores) == 2


def test_extract_keeps_feature_present_in_at_least_one_loan():
    full = {name: 2.0 for name in FEATURE_NAMES}
    loans = [_loan(0.5, **full)]

    features, scores, available = _extract_features_and_scores(loans)

    assert available == FEATURE_NAMES
    assert features.shape == (1, len(FEATURE_NAMES))


def test_extract_skips_loans_without_a_score():
    full = {name: 1.0 for name in FEATURE_NAMES}
    loans = [{"underwritingFeatures": full}, _loan(0.7, **full)]

    features, scores, available = _extract_features_and_scores(loans)

    assert len(scores) == 1
    assert features.shape[0] == 1
