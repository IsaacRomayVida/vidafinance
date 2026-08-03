"""
Tests for the pseudo-labeling module using SelfTrainingClassifier.
"""

import numpy as np
import pytest

from models.pseudo_labeler import PseudoLabeler


@pytest.fixture
def labeled_data():
    rng = np.random.RandomState(42)
    n = 200
    X = rng.randn(n, 5)
    y = (X[:, 0] + X[:, 1] > 0).astype(int)
    return X, y


@pytest.fixture
def unlabeled_data():
    rng = np.random.RandomState(99)
    return rng.randn(100, 5)


class TestPseudoLabeler:
    def test_fit_produces_summary(self, labeled_data, unlabeled_data):
        X_labeled, y_labeled = labeled_data
        labeler = PseudoLabeler()
        summary = labeler.fit(X_labeled, y_labeled, unlabeled_data, threshold=0.80)

        assert summary["n_labeled"] == 200
        assert summary["n_unlabeled"] == 100
        assert summary["n_pseudo_labeled"] >= 0
        assert summary["n_pseudo_labeled"] <= 100
        assert summary["n_iterations"] >= 1
        assert 0 <= summary["pseudo_label_rate"] <= 1.0

    def test_predict_proba_after_fit(self, labeled_data, unlabeled_data):
        X_labeled, y_labeled = labeled_data
        labeler = PseudoLabeler()
        labeler.fit(X_labeled, y_labeled, unlabeled_data)

        probs = labeler.predict_proba(X_labeled[:5])
        assert probs.shape == (5,)
        assert all(0 <= p <= 1 for p in probs)

    def test_predict_before_fit_raises(self):
        labeler = PseudoLabeler()
        with pytest.raises(RuntimeError, match="not trained"):
            labeler.predict_proba(np.zeros((1, 5)))

    def test_expanded_labels(self, labeled_data, unlabeled_data):
        X_labeled, y_labeled = labeled_data
        labeler = PseudoLabeler()
        labeler.fit(X_labeled, y_labeled, unlabeled_data)

        labels = labeler.get_expanded_labels(y_labeled, len(unlabeled_data))
        assert len(labels) == len(y_labeled) + len(unlabeled_data)
        # Original labels should be preserved
        np.testing.assert_array_equal(labels[: len(y_labeled)], y_labeled)

    def test_save_and_load(self, labeled_data, unlabeled_data, tmp_path):
        X_labeled, y_labeled = labeled_data
        labeler = PseudoLabeler()
        labeler.fit(X_labeled, y_labeled, unlabeled_data)

        path = str(tmp_path / "test_pl.joblib")
        labeler.save(path)
        loaded = PseudoLabeler.load(path)
        assert loaded.version == labeler.version

        # Same predictions
        original = labeler.predict_proba(X_labeled[:3])
        loaded_result = loaded.predict_proba(X_labeled[:3])
        np.testing.assert_array_almost_equal(original, loaded_result)

    def test_high_threshold_labels_fewer(self, labeled_data, unlabeled_data):
        X_labeled, y_labeled = labeled_data
        labeler_low = PseudoLabeler()
        labeler_high = PseudoLabeler()

        summary_low = labeler_low.fit(
            X_labeled, y_labeled, unlabeled_data, threshold=0.60
        )
        summary_high = labeler_high.fit(
            X_labeled, y_labeled, unlabeled_data, threshold=0.99
        )

        assert summary_high["n_pseudo_labeled"] <= summary_low["n_pseudo_labeled"]
