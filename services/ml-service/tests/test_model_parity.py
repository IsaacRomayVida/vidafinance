"""
Regression guard for models/underwriting_v1.joblib (GitHub issue #428, defect 2).

The artifact was originally pickled under numpy>=2.0, which requirements.txt's
pinned numpy==1.26.0 cannot load (numpy._core did not exist before 2.0). It was
re-pickled by extracting the fitted LogisticRegression weights/bias and
StandardScaler parameters as plain Python values and reconstructing the same
objects under numpy==1.26.0 — no retraining involved, so the fitted parameters
are unchanged bit-for-bit.

tests/model_parity_baseline.json records predict_proba for 24 fixed borrower
vectors (tests/model_parity_vectors.py), captured from the original artifact
in an environment with numpy>=2.0 before the re-pickle. This test proves the
re-pickled artifact scores those same borrowers identically, so a future
re-pickle that silently changes scores will fail CI instead of shipping.
"""

import json
import os

from models.underwriting_model import UnderwritingModel
from tests.model_parity_vectors import BORROWER_VECTORS

BASELINE_PATH = os.path.join(os.path.dirname(__file__), "model_parity_baseline.json")


def _load_baseline():
    with open(BASELINE_PATH) as f:
        return json.load(f)


def test_model_parity_matches_pre_repickle_baseline():
    model = UnderwritingModel.load("models/underwriting_v1.joblib")
    baseline = _load_baseline()

    assert len(baseline["results"]) == len(BORROWER_VECTORS)

    for expected, features in zip(baseline["results"], BORROWER_VECTORS):
        assert expected["features"] == features

        prob = model.predict_proba(features)
        label = int(prob >= 0.5)

        assert label == expected["predict_label"], (
            f"predicted class label changed for {features}: "
            f"was {expected['predict_label']}, now {label}"
        )
        assert (
            prob == expected["predict_proba"]
            or abs(prob - expected["predict_proba"]) < 1e-6
        ), (
            f"predict_proba drifted for {features}: "
            f"was {expected['predict_proba']}, now {prob}"
        )
