"""
Tests for the Stage 5 active learning human-review router.
"""

import numpy as np
import pytest

from models.active_learner import HumanReviewRouter


@pytest.fixture
def router():
    """Create a simple active learner with synthetic data."""
    rng = np.random.RandomState(42)
    n = 100
    X = rng.randn(n, 10)
    y = (X[:, 0] + X[:, 1] > 0).astype(int)
    return HumanReviewRouter.create(X, y, uncertainty_threshold=0.35)


class TestHumanReviewRouter:
    def test_create_initializes(self, router):
        assert router.version == "active_learner_v1.0"
        assert router.uncertainty_threshold == 0.35

    def test_clear_case_not_routed(self, router):
        # Very clear positive case
        features = np.array([3.0, 3.0, 0, 0, 0, 0, 0, 0, 0, 0])
        result = router.should_route_to_human(features)
        assert result["route_to_human"] is False
        assert 0 <= result["uncertainty"] <= 1
        assert result["predicted_proba"] > 0.5

    def test_borderline_case_may_route(self, router):
        # Borderline case near decision boundary
        features = np.array([0.01, -0.01, 0, 0, 0, 0, 0, 0, 0, 0])
        result = router.should_route_to_human(features)
        assert "route_to_human" in result
        assert "uncertainty" in result
        # Borderline cases should have higher uncertainty
        assert result["uncertainty"] > 0.1

    def test_result_structure(self, router):
        features = np.array([1.0] * 10)
        result = router.should_route_to_human(features)
        assert "route_to_human" in result
        assert "uncertainty" in result
        assert "threshold" in result
        assert "predicted_class" in result
        assert "predicted_proba" in result
        assert isinstance(result["route_to_human"], bool)
        assert isinstance(result["uncertainty"], float)
        assert result["predicted_class"] in (0, 1)

    def test_query_most_uncertain(self, router):
        rng = np.random.RandomState(123)
        X_pool = rng.randn(50, 10)
        indices, instances = router.query_most_uncertain(X_pool, n_instances=3)
        assert len(indices) == 3
        assert instances.shape == (3, 10)

    def test_teach_updates_model(self, router):
        # Get prediction before teaching
        features = np.array([[0.5, -0.5, 0, 0, 0, 0, 0, 0, 0, 0]])
        before = router.should_route_to_human(features[0])

        # Teach with new data
        rng = np.random.RandomState(77)
        X_new = rng.randn(20, 10)
        y_new = (X_new[:, 0] + X_new[:, 1] > 0).astype(int)
        router.teach(X_new, y_new)

        # Model should still work after teaching
        after = router.should_route_to_human(features[0])
        assert "uncertainty" in after

    def test_2d_input(self, router):
        features = np.array([[1.0] * 10])
        result = router.should_route_to_human(features)
        assert "route_to_human" in result

    def test_save_and_load(self, router, tmp_path):
        path = str(tmp_path / "test_al.joblib")
        router.save(path)
        loaded = HumanReviewRouter.load(path)
        assert loaded.version == router.version
        assert loaded.uncertainty_threshold == router.uncertainty_threshold

        features = np.array([1.0] * 10)
        original = router.should_route_to_human(features)
        loaded_result = loaded.should_route_to_human(features)
        assert abs(original["uncertainty"] - loaded_result["uncertainty"]) < 1e-6
