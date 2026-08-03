"""
Generate PSI/CSI baseline from the current champion model and training data.

Produces models/baselines/v1_baseline.json containing:
  - Per-feature statistics (mean, std, min, max, percentiles)
  - Per-feature histograms for CSI comparison
  - Score distribution histogram for PSI comparison

Usage: python scripts/generate_baseline.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np

from models.underwriting_model import UnderwritingModel
from models.drift_monitor import (
    FEATURE_NAMES,
    generate_baseline_from_data,
    save_baseline,
)
from scripts.train_baseline_model import generate_synthetic_dataset

SEED = 42
N = 5000


def main():
    rng = np.random.default_rng(SEED)
    X, _y = generate_synthetic_dataset(N, rng)

    # Load trained model and score all samples
    model_path = os.path.join(
        os.path.dirname(__file__), "..", "models", "underwriting_v1.joblib"
    )
    model = UnderwritingModel.load(os.path.abspath(model_path))

    scores = np.array([model.predict_proba(dict(zip(FEATURE_NAMES, row))) for row in X])

    print(f"Scored {len(scores)} samples")
    print(f"Score distribution: mean={scores.mean():.4f}, std={scores.std():.4f}")
    print(f"Score range: [{scores.min():.4f}, {scores.max():.4f}]")

    baseline = generate_baseline_from_data(X, scores)

    output_path = os.path.join(
        os.path.dirname(__file__), "..", "models", "baselines", "v1_baseline.json"
    )
    save_baseline(baseline, os.path.abspath(output_path))
    print(f"Baseline saved to {output_path}")
    print(f"Features: {len(baseline['features'])}")
    for name, stats in baseline["features"].items():
        print(f"  {name}: mean={stats['mean']}, std={stats['std']}")


if __name__ == "__main__":
    main()
