"""
Embedding + k-NN model for thin-file applicants.

When bureau data is unavailable or sparse (thin-file), this model uses
OpenAI embeddings of borrower profile text + FAISS nearest-neighbor
search to find similar historical applicants and estimate risk from
their outcomes.

Pipeline:
  1. Encode borrower profile text via OpenAI text-embedding-3-small
  2. Query FAISS index for k nearest neighbors from resolved loans
  3. Aggregate neighbor outcomes → estimated P(repayment)
"""

import json
import logging
import os
from typing import Optional

import numpy as np

logger = logging.getLogger("ml-service.thin_file_knn")

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
DEFAULT_K = 10
DEFAULT_INDEX_PATH = os.path.join(os.path.dirname(__file__), "thin_file_index.faiss")
DEFAULT_META_PATH = os.path.join(os.path.dirname(__file__), "thin_file_meta.json")


# The pay-frequency vocabulary this index was TRAINED on
# (scripts/train_thin_file_index.py). Anything outside it is a token the
# embedding has never seen.
TRAINED_PAY_FREQUENCIES = ("weekly", "biweekly", "monthly")

# Cadences that arrived after the index was built, mapped onto the trained token
# that means the same thing for this feature.
#
# 'semimonthly' (the 15th and the last day) became writable at onboarding in
# #435. It is two paydays a month, which is what 'biweekly' represents here, so
# it embeds as biweekly rather than as an out-of-vocabulary token. This is the
# bounded fix: the alternative is retraining the index, and a retrain is a model
# change with its own evidence requirements rather than a bug fix. Retraining
# remains the right long-term answer and is tracked on #435.
PAY_FREQUENCY_ALIASES = {"semimonthly": "biweekly"}


def normalise_pay_frequency(value: object) -> str:
    """
    Map a borrower's cadence onto the trained vocabulary.

    Unknown values fall back to 'monthly' — the same default this function has
    always applied to a missing field — rather than embedding a token the index
    has never seen. An unseen token does not fail; it just matches badly, on the
    applicants who by definition have the least other signal.
    """
    frequency = value if isinstance(value, str) else "monthly"
    frequency = PAY_FREQUENCY_ALIASES.get(frequency, frequency)
    return frequency if frequency in TRAINED_PAY_FREQUENCIES else "monthly"


def build_profile_text(borrower: dict) -> str:
    """
    Build a text representation of a borrower profile for embedding.

    Includes employment, income, and employer characteristics that
    are available even for thin-file applicants.
    """
    parts = [
        f"salary:{borrower.get('monthlySalary', 0)}",
        f"tenure_months:{borrower.get('employmentTenureMonths', 0)}",
        f"industry:{borrower.get('employerIndustry', 'unknown')}",
        f"employer_tier:{borrower.get('employerTier', 3)}",
        f"pay_frequency:{normalise_pay_frequency(borrower.get('payFrequency'))}",
        f"company_size:{borrower.get('companySize', 'unknown')}",
        f"sector_risk:{borrower.get('sectorRisk', 3)}",
        f"afore_regularity:{borrower.get('aforeRegularity', 0.0):.2f}",
        f"riskseal_score:{borrower.get('riskSealScore', 50)}",
        f"loan_amount:{borrower.get('principalAmount', 0)}",
    ]
    return " ".join(parts)


class ThinFileKNN:
    """
    Embedding + k-NN estimator for thin-file applicants.

    Uses FAISS for fast approximate nearest-neighbor search over
    OpenAI embeddings of historical borrower profiles.
    """

    def __init__(self, index, metadata: list[dict], openai_client=None):
        """
        Args:
            index: FAISS index containing embeddings.
            metadata: List of dicts with 'outcome' (0/1) and 'loan_id' for each vector.
            openai_client: OpenAI client instance (lazy-loaded if None).
        """
        self.index = index
        self.metadata = metadata
        self._openai_client = openai_client
        self.version = "thin_file_knn_v1.0"

    @property
    def openai_client(self):
        if self._openai_client is None:
            from openai import OpenAI

            self._openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
        return self._openai_client

    def embed(self, text: str) -> np.ndarray:
        """Get embedding vector from OpenAI."""
        response = self.openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=text,
        )
        return np.array(response.data[0].embedding, dtype=np.float32)

    def predict(self, borrower: dict, k: int = DEFAULT_K) -> dict:
        """
        Estimate P(repayment) for a thin-file applicant.

        Args:
            borrower: Borrower profile dict.
            k: Number of nearest neighbors.

        Returns:
            {
                "repayment_probability": float,
                "n_neighbors": int,
                "neighbor_outcomes": list[float],
                "is_thin_file": True,
                "confidence": float,
            }
        """
        profile_text = build_profile_text(borrower)
        embedding = self.embed(profile_text).reshape(1, -1)

        # Search FAISS index
        distances, indices = self.index.search(embedding, k)
        distances = distances[0]
        indices = indices[0]

        # Filter out invalid indices (-1 from FAISS when index is small)
        valid_mask = indices >= 0
        valid_indices = indices[valid_mask]
        valid_distances = distances[valid_mask]

        if len(valid_indices) == 0:
            return {
                "repayment_probability": 0.5,
                "n_neighbors": 0,
                "neighbor_outcomes": [],
                "is_thin_file": True,
                "confidence": 0.0,
            }

        # Collect neighbor outcomes
        outcomes = []
        for idx in valid_indices:
            if idx < len(self.metadata):
                outcomes.append(float(self.metadata[int(idx)].get("outcome", 0.5)))

        if not outcomes:
            return {
                "repayment_probability": 0.5,
                "n_neighbors": 0,
                "neighbor_outcomes": [],
                "is_thin_file": True,
                "confidence": 0.0,
            }

        # Distance-weighted average (closer neighbors get more weight)
        # Add epsilon to avoid division by zero
        weights = 1.0 / (valid_distances + 1e-6)
        weighted_outcomes = np.array(outcomes) * weights[: len(outcomes)]
        repayment_prob = float(weighted_outcomes.sum() / weights[: len(outcomes)].sum())

        # Confidence based on neighbor count and distance spread
        confidence = min(1.0, len(outcomes) / k) * (
            1.0 / (1.0 + float(valid_distances.mean()))
        )

        return {
            "repayment_probability": round(repayment_prob, 4),
            "n_neighbors": len(outcomes),
            "neighbor_outcomes": [round(o, 2) for o in outcomes],
            "is_thin_file": True,
            "confidence": round(confidence, 4),
        }

    def add_resolved_loan(self, borrower: dict, outcome: float, loan_id: str):
        """
        Add a resolved loan to the index for future lookups.

        Args:
            borrower: Borrower profile dict.
            outcome: 1.0 = repaid, 0.0 = defaulted.
            loan_id: Unique loan identifier.
        """
        profile_text = build_profile_text(borrower)
        embedding = self.embed(profile_text).reshape(1, -1)

        self.index.add(embedding)
        self.metadata.append({"outcome": outcome, "loan_id": loan_id})

    def save(
        self, index_path: str = DEFAULT_INDEX_PATH, meta_path: str = DEFAULT_META_PATH
    ):
        """Save FAISS index and metadata."""
        import faiss

        faiss.write_index(self.index, index_path)
        with open(meta_path, "w") as f:
            json.dump(self.metadata, f)
        logger.info(
            "Saved thin-file index (%d vectors) to %s", self.index.ntotal, index_path
        )

    @classmethod
    def load(
        cls,
        index_path: str = DEFAULT_INDEX_PATH,
        meta_path: str = DEFAULT_META_PATH,
    ) -> "ThinFileKNN":
        """Load FAISS index and metadata from disk."""
        import faiss

        index = faiss.read_index(index_path)
        with open(meta_path) as f:
            metadata = json.load(f)
        return cls(index=index, metadata=metadata)

    @classmethod
    def create_empty(cls) -> "ThinFileKNN":
        """Create a new empty index."""
        import faiss

        index = faiss.IndexFlatL2(EMBEDDING_DIM)
        return cls(index=index, metadata=[])
