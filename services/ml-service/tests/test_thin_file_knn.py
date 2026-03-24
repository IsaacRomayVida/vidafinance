"""
Tests for the thin-file k-NN model (embedding + FAISS).

These tests use synthetic embeddings to avoid requiring an OpenAI API key.
"""

import json

import numpy as np
import pytest

try:
    import faiss
    HAS_FAISS = True
except ImportError:
    HAS_FAISS = False

from models.thin_file_knn import ThinFileKNN, build_profile_text, EMBEDDING_DIM


pytestmark = pytest.mark.skipif(not HAS_FAISS, reason="faiss-cpu not installed")


@pytest.fixture
def synthetic_index():
    """Create a FAISS index with synthetic embeddings."""
    rng = np.random.RandomState(42)
    n = 50
    index = faiss.IndexFlatL2(EMBEDDING_DIM)
    metadata = []

    for i in range(n):
        embedding = rng.randn(EMBEDDING_DIM).astype(np.float32)
        embedding /= np.linalg.norm(embedding)
        index.add(embedding.reshape(1, -1))
        metadata.append({
            "outcome": float(rng.binomial(1, 0.7)),
            "loan_id": f"test_{i:03d}",
        })

    return ThinFileKNN(index=index, metadata=metadata)


class TestBuildProfileText:
    def test_builds_text_with_all_fields(self):
        borrower = {
            "monthlySalary": 25000,
            "employmentTenureMonths": 36,
            "employerIndustry": "technology",
            "employerTier": 1,
            "payFrequency": "biweekly",
            "companySize": "51-200",
            "sectorRisk": 1,
            "aforeRegularity": 0.85,
            "riskSealScore": 75,
            "principalAmount": 3000,
        }
        text = build_profile_text(borrower)
        assert "salary:25000" in text
        assert "tenure_months:36" in text
        assert "industry:technology" in text

    def test_builds_text_with_defaults(self):
        text = build_profile_text({})
        assert "salary:0" in text
        assert "industry:unknown" in text


class TestThinFileKNN:
    def test_index_has_vectors(self, synthetic_index):
        assert synthetic_index.index.ntotal == 50
        assert len(synthetic_index.metadata) == 50

    def test_create_empty(self):
        knn = ThinFileKNN.create_empty()
        assert knn.index.ntotal == 0
        assert knn.metadata == []

    def test_save_and_load(self, synthetic_index, tmp_path):
        index_path = str(tmp_path / "test.faiss")
        meta_path = str(tmp_path / "test_meta.json")
        synthetic_index.save(index_path, meta_path)

        loaded = ThinFileKNN.load(index_path, meta_path)
        assert loaded.index.ntotal == 50
        assert len(loaded.metadata) == 50

    def test_predict_with_mock_embedding(self, synthetic_index):
        """Test prediction by mocking the embed method."""
        rng = np.random.RandomState(99)

        # Mock the embed method to return a random vector
        original_embed = synthetic_index.embed
        synthetic_index.embed = lambda text: rng.randn(EMBEDDING_DIM).astype(np.float32)

        result = synthetic_index.predict({"monthlySalary": 20000}, k=5)

        assert "repayment_probability" in result
        assert 0 <= result["repayment_probability"] <= 1
        assert result["is_thin_file"] is True
        assert result["n_neighbors"] <= 5
        assert "confidence" in result

        synthetic_index.embed = original_embed

    def test_add_resolved_loan(self):
        """Test adding a new vector to the index."""
        knn = ThinFileKNN.create_empty()
        rng = np.random.RandomState(42)

        # Mock the embed method
        knn.embed = lambda text: rng.randn(EMBEDDING_DIM).astype(np.float32)

        knn.add_resolved_loan(
            borrower={"monthlySalary": 15000},
            outcome=1.0,
            loan_id="test_new",
        )
        assert knn.index.ntotal == 1
        assert knn.metadata[0]["loan_id"] == "test_new"
        assert knn.metadata[0]["outcome"] == 1.0

    def test_empty_index_returns_default(self, synthetic_index):
        """Empty index returns 0.5 probability with 0 confidence."""
        empty_knn = ThinFileKNN.create_empty()
        rng = np.random.RandomState(42)
        empty_knn.embed = lambda text: rng.randn(EMBEDDING_DIM).astype(np.float32)

        result = empty_knn.predict({})
        assert result["repayment_probability"] == 0.5
        assert result["n_neighbors"] == 0
        assert result["confidence"] == 0.0
