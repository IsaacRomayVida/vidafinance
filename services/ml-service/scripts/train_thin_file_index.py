"""
Build the FAISS thin-file k-NN index from resolved loan data.

In production, this loads resolved loan data from Firestore. For
initial setup, generates synthetic profiles and embeds them via
OpenAI text-embedding-3-small.

Usage:
    cd services/ml-service
    OPENAI_API_KEY=sk-... python scripts/train_thin_file_index.py
"""

import json
import os
import sys
import logging

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from models.thin_file_knn import ThinFileKNN, EMBEDDING_DIM

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("train_thin_file_index")


def generate_synthetic_profiles(n: int = 500, seed: int = 42) -> list[dict]:
    """Generate synthetic borrower profiles with outcomes."""
    rng = np.random.RandomState(seed)
    industries = [
        "manufacturing",
        "logistics",
        "retail",
        "technology",
        "healthcare",
        "construction",
    ]
    pay_freqs = ["weekly", "biweekly", "monthly"]

    profiles = []
    for i in range(n):
        salary = float(rng.uniform(8000, 45000))
        tenure = int(rng.uniform(1, 120))
        tier = int(rng.choice([1, 2, 3], p=[0.3, 0.5, 0.2]))
        risk = int(rng.choice([1, 2, 3], p=[0.3, 0.4, 0.3]))

        # Outcome correlates with salary, tenure, tier
        repay_prob = (
            0.3
            + 0.2 * (salary / 45000)
            + 0.2 * (tenure / 120)
            + 0.15 * (1 - tier / 3)
            + 0.1 * (1 - risk / 3)
        )
        outcome = float(rng.binomial(1, min(0.95, max(0.05, repay_prob))))

        profiles.append(
            {
                "borrower": {
                    "monthlySalary": salary,
                    "employmentTenureMonths": tenure,
                    "employerIndustry": rng.choice(industries),
                    "employerTier": tier,
                    "payFrequency": rng.choice(pay_freqs),
                    "companySize": rng.choice(["1-10", "11-50", "51-200", "201-500"]),
                    "sectorRisk": risk,
                    "aforeRegularity": float(rng.uniform(0.3, 1.0)),
                    "riskSealScore": float(rng.uniform(20, 90)),
                    "principalAmount": float(rng.uniform(1000, 5000)),
                },
                "outcome": outcome,
                "loan_id": f"synthetic_{i:04d}",
            }
        )
    return profiles


def main():
    logger.info("=== Building Thin-File k-NN Index ===")

    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        logger.warning(
            "OPENAI_API_KEY not set — generating synthetic embeddings for testing"
        )
        _build_synthetic_index()
        return

    from openai import OpenAI

    client = OpenAI(api_key=openai_key)

    profiles = generate_synthetic_profiles(500)
    logger.info("Generated %d synthetic profiles", len(profiles))

    knn = ThinFileKNN.create_empty()
    knn._openai_client = client

    for i, profile in enumerate(profiles):
        knn.add_resolved_loan(
            borrower=profile["borrower"],
            outcome=profile["outcome"],
            loan_id=profile["loan_id"],
        )
        if (i + 1) % 50 == 0:
            logger.info("Indexed %d / %d profiles", i + 1, len(profiles))

    output_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "models",
    )
    knn.save(
        index_path=os.path.join(output_dir, "thin_file_index.faiss"),
        meta_path=os.path.join(output_dir, "thin_file_meta.json"),
    )
    logger.info("Index saved (%d vectors)", knn.index.ntotal)


def _build_synthetic_index():
    """Build a test index with random embeddings (no OpenAI key needed)."""
    import faiss

    profiles = generate_synthetic_profiles(200)
    rng = np.random.RandomState(123)

    index = faiss.IndexFlatL2(EMBEDDING_DIM)
    metadata = []

    for profile in profiles:
        embedding = rng.randn(EMBEDDING_DIM).astype(np.float32)
        embedding /= np.linalg.norm(embedding)
        index.add(embedding.reshape(1, -1))
        metadata.append(
            {
                "outcome": profile["outcome"],
                "loan_id": profile["loan_id"],
            }
        )

    output_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "models",
    )
    faiss.write_index(index, os.path.join(output_dir, "thin_file_index.faiss"))
    with open(os.path.join(output_dir, "thin_file_meta.json"), "w") as f:
        json.dump(metadata, f)

    logger.info("Synthetic index saved (%d vectors)", index.ntotal)


if __name__ == "__main__":
    main()
