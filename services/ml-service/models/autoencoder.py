"""
PyTorch autoencoder for Stage 4 behavioral fraud detection.

Architecture: 7 → 4 → 2 → 4 → 7
Input features (MetaMap device signals):
  [emulator_detected, vpn_detected, rooted_device, device_age_days,
   ip_reputation_score, session_duration_seconds, interaction_anomaly_score]

Anomaly detection via reconstruction error: legitimate sessions reconstruct
well (low MSE), fraudulent sessions produce high reconstruction error.
"""

import os

import numpy as np
import torch
import torch.nn as nn

FEATURE_NAMES = [
    "emulator_detected",
    "vpn_detected",
    "rooted_device",
    "device_age_days",
    "ip_reputation_score",
    "session_duration_seconds",
    "interaction_anomaly_score",
]

# Normalization ranges for each feature (used to scale inputs to [0, 1])
FEATURE_RANGES = {
    "emulator_detected": (0.0, 1.0),
    "vpn_detected": (0.0, 1.0),
    "rooted_device": (0.0, 1.0),
    "device_age_days": (0.0, 3650.0),
    "ip_reputation_score": (0.0, 100.0),
    "session_duration_seconds": (0.0, 3600.0),
    "interaction_anomaly_score": (0.0, 100.0),
}

INPUT_DIM = 7
DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "autoencoder_v2_metamap.pt"
)


class MetaMapAutoencoder(nn.Module):
    """Symmetric autoencoder: 7 → 4 → 2 → 4 → 7."""

    def __init__(self):
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Linear(INPUT_DIM, 4),
            nn.ReLU(),
            nn.Linear(4, 2),
            nn.ReLU(),
        )
        self.decoder = nn.Sequential(
            nn.Linear(2, 4),
            nn.ReLU(),
            nn.Linear(4, INPUT_DIM),
            nn.Sigmoid(),  # outputs in [0,1] since inputs are normalized
        )

    def forward(self, x):
        z = self.encoder(x)
        return self.decoder(z)


def normalize_features(raw: dict) -> np.ndarray:
    """Normalize a raw feature dict to [0, 1] using known ranges."""
    values = []
    for name in FEATURE_NAMES:
        val = float(raw.get(name, 0.0))
        lo, hi = FEATURE_RANGES[name]
        normalized = (val - lo) / (hi - lo) if hi > lo else 0.0
        values.append(max(0.0, min(1.0, normalized)))
    return np.array(values, dtype=np.float32)


def compute_reconstruction_error(
    model: MetaMapAutoencoder, features: np.ndarray
) -> float:
    """Compute MSE reconstruction error for a single sample."""
    model.eval()
    with torch.no_grad():
        x = torch.tensor(features, dtype=torch.float32).unsqueeze(0)
        x_hat = model(x)
        mse = nn.functional.mse_loss(x_hat, x).item()
    return mse


class AnomalyDetector:
    """Wraps the autoencoder with a calibrated threshold for fraud detection."""

    def __init__(self, model: MetaMapAutoencoder, threshold: float):
        self.model = model
        self.threshold = threshold

    def predict(self, raw_features: dict) -> dict:
        """
        Score a single session for anomaly.

        Returns:
            {
                "reconstruction_error": float,
                "is_anomaly": bool,
                "threshold": float,
            }
        """
        features = normalize_features(raw_features)
        error = compute_reconstruction_error(self.model, features)
        return {
            "reconstruction_error": round(error, 6),
            "is_anomaly": error > self.threshold,
            "threshold": self.threshold,
        }

    def save(self, path: str = DEFAULT_MODEL_PATH):
        """Save model weights and threshold."""
        torch.save(
            {"state_dict": self.model.state_dict(), "threshold": self.threshold},
            path,
        )

    @classmethod
    def load(cls, path: str = DEFAULT_MODEL_PATH) -> "AnomalyDetector":
        """Load model weights and threshold from disk."""
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
        model = MetaMapAutoencoder()
        model.load_state_dict(checkpoint["state_dict"])
        model.eval()
        return cls(model=model, threshold=checkpoint["threshold"])
