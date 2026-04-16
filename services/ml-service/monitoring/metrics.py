"""
Prometheus metrics for the ML service.

Exposes counters and histograms for prediction volume, latency, and model
version tracking.  Mount the ASGI app returned by `metrics_app()` on
"/metrics" to enable scraping.
"""

from prometheus_client import Counter, Histogram, Info, make_asgi_app

# ── Prediction counters ──────────────────────────────────────────────────────

predictions_total = Counter(
    "ml_predictions_total",
    "Total predictions by decision and model version",
    ["decision", "model_version"],
)

# ── Prediction latency ──────────────────────────────────────────────────────

prediction_latency = Histogram(
    "ml_prediction_latency_seconds",
    "End-to-end prediction latency",
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# ── Model info gauge ─────────────────────────────────────────────────────────

model_info = Info(
    "ml_model",
    "Currently loaded model versions",
)


def record_prediction(decision: str, model_version: str) -> None:
    """Increment the prediction counter for the given decision/version."""
    predictions_total.labels(decision=decision, model_version=model_version).inc()


def set_model_info(champion: str, challenger: str) -> None:
    """Update the model-info gauge with currently loaded versions."""
    model_info.info({"champion": champion, "challenger": challenger})


def metrics_app():
    """Return an ASGI app that serves /metrics for Prometheus scraping."""
    return make_asgi_app()
