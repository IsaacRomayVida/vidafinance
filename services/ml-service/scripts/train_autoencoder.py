"""
Train the MetaMap autoencoder for Stage 4 behavioral fraud detection.

Data sources (in priority order):
  1. metamap_shadow_log Firestore collection (Sprint 1 dual-run data)
  2. Synthetic data generated to match expected MetaMap signal distributions

The autoencoder is trained on *legitimate* sessions only. Fraud is detected
at inference time via high reconstruction error (the model cannot reconstruct
patterns it has not learned).

Threshold calibration:
  - Inject known-fraud patterns into a held-out set
  - Select threshold via ROC analysis to maximize separation

Usage:
  python scripts/train_autoencoder.py [--firestore] [--epochs 100]
"""

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

from models.autoencoder import (
    AnomalyDetector,
    MetaMapAutoencoder,
    normalize_features,
    FEATURE_NAMES,
    compute_reconstruction_error,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("train_autoencoder")

SEED = 42
rng = np.random.default_rng(SEED)


# ── Data generation ──────────────────────────────────────────────────────────


def generate_legitimate_samples(n: int, rng: np.random.Generator) -> list[dict]:
    """Generate synthetic legitimate session data matching MetaMap signals."""
    samples = []
    for _ in range(n):
        samples.append(
            {
                "emulator_detected": 0.0,
                "vpn_detected": float(rng.random() < 0.05),  # 5% use VPN legitimately
                "rooted_device": float(rng.random() < 0.03),  # 3% rooted
                "device_age_days": float(rng.integers(30, 2500)),
                "ip_reputation_score": float(rng.uniform(60, 100)),  # good reputation
                "session_duration_seconds": float(rng.uniform(120, 1800)),
                "interaction_anomaly_score": float(rng.uniform(0, 25)),  # low anomaly
            }
        )
    return samples


def generate_fraud_samples(n: int, rng: np.random.Generator) -> list[dict]:
    """Generate synthetic fraud session data with suspicious patterns."""
    samples = []
    for _ in range(n):
        fraud_type = rng.choice(["bot", "emulator", "identity_theft", "mixed"])
        sample = {
            "emulator_detected": 0.0,
            "vpn_detected": 0.0,
            "rooted_device": 0.0,
            "device_age_days": float(rng.integers(1, 3650)),
            "ip_reputation_score": float(rng.uniform(0, 100)),
            "session_duration_seconds": float(rng.uniform(5, 3600)),
            "interaction_anomaly_score": float(rng.uniform(0, 100)),
        }

        if fraud_type == "bot":
            sample["session_duration_seconds"] = float(rng.uniform(5, 30))
            sample["interaction_anomaly_score"] = float(rng.uniform(70, 100))
            sample["ip_reputation_score"] = float(rng.uniform(0, 30))
        elif fraud_type == "emulator":
            sample["emulator_detected"] = 1.0
            sample["device_age_days"] = float(rng.integers(0, 5))
            sample["rooted_device"] = 1.0
            sample["interaction_anomaly_score"] = float(rng.uniform(50, 90))
        elif fraud_type == "identity_theft":
            sample["vpn_detected"] = 1.0
            sample["ip_reputation_score"] = float(rng.uniform(0, 25))
            sample["interaction_anomaly_score"] = float(rng.uniform(55, 95))
            sample["device_age_days"] = float(rng.integers(0, 10))
        else:  # mixed
            sample["emulator_detected"] = float(rng.random() < 0.6)
            sample["vpn_detected"] = float(rng.random() < 0.7)
            sample["rooted_device"] = float(rng.random() < 0.5)
            sample["device_age_days"] = float(rng.integers(0, 15))
            sample["ip_reputation_score"] = float(rng.uniform(0, 35))
            sample["session_duration_seconds"] = float(rng.uniform(5, 60))
            sample["interaction_anomaly_score"] = float(rng.uniform(60, 100))

        samples.append(sample)
    return samples


def load_firestore_shadow_logs() -> list[dict]:
    """
    Load dual-run shadow log data from metamap_shadow_log Firestore collection.

    Each document has the 7 MetaMap device signal fields plus an optional
    'is_fraud' label from manual review.
    """
    try:
        from services.firestore_client import FirestoreClient

        fs = FirestoreClient()
        docs = fs._db.collection("metamap_shadow_log").stream()
        samples = []
        for doc in docs:
            data = doc.to_dict()
            sample = {name: float(data.get(name, 0.0)) for name in FEATURE_NAMES}
            if "is_fraud" in data:
                sample["is_fraud"] = bool(data["is_fraud"])
            samples.append(sample)
        logger.info("Loaded %d shadow log samples from Firestore", len(samples))
        return samples
    except Exception as e:
        logger.warning("Could not load Firestore shadow logs: %s", e)
        return []


# ── Training ─────────────────────────────────────────────────────────────────


def train_autoencoder(
    legitimate_samples: list[dict],
    epochs: int = 100,
    batch_size: int = 64,
    lr: float = 1e-3,
) -> MetaMapAutoencoder:
    """Train autoencoder on legitimate samples only."""
    torch.manual_seed(SEED)

    # Normalize all samples
    X = np.array([normalize_features(s) for s in legitimate_samples], dtype=np.float32)
    dataset = TensorDataset(torch.tensor(X))
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    model = MetaMapAutoencoder()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.MSELoss()

    model.train()
    for epoch in range(epochs):
        total_loss = 0.0
        for (batch,) in loader:
            optimizer.zero_grad()
            output = model(batch)
            loss = criterion(output, batch)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * len(batch)
        avg_loss = total_loss / len(X)
        if (epoch + 1) % 20 == 0 or epoch == 0:
            logger.info("Epoch %3d/%d — loss: %.6f", epoch + 1, epochs, avg_loss)

    return model


# ── Threshold calibration ────────────────────────────────────────────────────


def calibrate_threshold(
    model: MetaMapAutoencoder,
    legitimate_samples: list[dict],
    fraud_samples: list[dict],
) -> float:
    """
    Calibrate anomaly threshold via ROC analysis.

    Picks the threshold that maximizes (TPR - FPR), i.e., Youden's J statistic.
    """
    model.eval()

    legit_errors = [
        compute_reconstruction_error(model, normalize_features(s))
        for s in legitimate_samples
    ]
    fraud_errors = [
        compute_reconstruction_error(model, normalize_features(s))
        for s in fraud_samples
    ]

    logger.info(
        "Legit errors  — mean: %.6f, std: %.6f, max: %.6f",
        np.mean(legit_errors),
        np.std(legit_errors),
        np.max(legit_errors),
    )
    logger.info(
        "Fraud errors  — mean: %.6f, std: %.6f, min: %.6f",
        np.mean(fraud_errors),
        np.std(fraud_errors),
        np.min(fraud_errors),
    )

    # Scan thresholds and pick best Youden's J
    all_errors = sorted(set(legit_errors + fraud_errors))
    best_threshold = float(np.median(legit_errors))
    best_j = -1.0

    for threshold in all_errors:
        tp = sum(1 for e in fraud_errors if e > threshold)
        fp = sum(1 for e in legit_errors if e > threshold)
        tpr = tp / max(len(fraud_errors), 1)
        fpr = fp / max(len(legit_errors), 1)
        j = tpr - fpr
        if j > best_j:
            best_j = j
            best_threshold = threshold

    # Compute final metrics at chosen threshold
    tp = sum(1 for e in fraud_errors if e > best_threshold)
    fp = sum(1 for e in legit_errors if e > best_threshold)
    fn = len(fraud_errors) - tp
    tn = len(legit_errors) - fp
    tpr = tp / max(tp + fn, 1)
    fpr = fp / max(fp + tn, 1)
    precision = tp / max(tp + fp, 1)

    logger.info("Calibrated threshold: %.6f", best_threshold)
    logger.info(
        "TPR (recall): %.2f%% | FPR: %.2f%% | Precision: %.2f%%",
        tpr * 100,
        fpr * 100,
        precision * 100,
    )

    return best_threshold


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Train MetaMap autoencoder")
    parser.add_argument(
        "--firestore",
        action="store_true",
        help="Load training data from metamap_shadow_log Firestore collection",
    )
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument(
        "--n-legit",
        type=int,
        default=3000,
        help="Number of synthetic legitimate samples",
    )
    parser.add_argument(
        "--n-fraud",
        type=int,
        default=500,
        help="Number of synthetic fraud samples for calibration",
    )
    args = parser.parse_args()

    # ── 1. Collect training data ─────────────────────────────────────────────
    firestore_samples = []
    if args.firestore:
        firestore_samples = load_firestore_shadow_logs()

    if firestore_samples:
        # Separate labeled fraud from legitimate
        labeled_fraud = [s for s in firestore_samples if s.pop("is_fraud", False)]
        legitimate = [
            s
            for s in firestore_samples
            if "is_fraud" not in s or not s.pop("is_fraud", False)
        ]
        logger.info(
            "Firestore: %d legitimate, %d labeled fraud",
            len(legitimate),
            len(labeled_fraud),
        )

        # Supplement with synthetic if needed
        if len(legitimate) < 500:
            extra = generate_legitimate_samples(500 - len(legitimate), rng)
            legitimate.extend(extra)
            logger.info("Added %d synthetic legitimate samples", len(extra))
        if len(labeled_fraud) < 100:
            extra = generate_fraud_samples(100 - len(labeled_fraud), rng)
            labeled_fraud.extend(extra)
            logger.info("Added %d synthetic fraud samples", len(extra))
    else:
        logger.info("Using synthetic data (no Firestore shadow logs available)")
        legitimate = generate_legitimate_samples(args.n_legit, rng)
        labeled_fraud = generate_fraud_samples(args.n_fraud, rng)

    # Hold out 20% of legitimate for threshold calibration
    split = int(len(legitimate) * 0.8)
    train_legit = legitimate[:split]
    val_legit = legitimate[split:]

    logger.info(
        "Training: %d legitimate | Validation: %d legit + %d fraud",
        len(train_legit),
        len(val_legit),
        len(labeled_fraud),
    )

    # ── 2. Train autoencoder ─────────────────────────────────────────────────
    model = train_autoencoder(train_legit, epochs=args.epochs)

    # ── 3. Calibrate threshold ───────────────────────────────────────────────
    threshold = calibrate_threshold(model, val_legit, labeled_fraud)

    # ── 4. Save model artifact ───────────────────────────────────────────────
    output_path = os.path.join(
        os.path.dirname(__file__), "..", "models", "autoencoder_v2_metamap.pt"
    )
    output_path = os.path.abspath(output_path)

    detector = AnomalyDetector(model=model, threshold=threshold)
    detector.save(output_path)
    logger.info("Model saved to: %s", output_path)

    # ── 5. Validate ──────────────────────────────────────────────────────────
    loaded = AnomalyDetector.load(output_path)

    # Test on a known-fraud sample
    fraud_test = labeled_fraud[0]
    result = loaded.predict(fraud_test)
    logger.info(
        "Fraud test  — error: %.6f, is_anomaly: %s",
        result["reconstruction_error"],
        result["is_anomaly"],
    )

    # Test on a known-legit sample
    legit_test = val_legit[0]
    result = loaded.predict(legit_test)
    logger.info(
        "Legit test  — error: %.6f, is_anomaly: %s",
        result["reconstruction_error"],
        result["is_anomaly"],
    )


if __name__ == "__main__":
    main()
