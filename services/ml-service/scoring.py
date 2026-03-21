def employer_score(p):
    sz = {"1-10": 5, "11-50": 30, "51-200": 125, "201-500": 350, "500+": 750}.get(
        p.get("companySize", "1-10"), 5
    )
    s = 50
    if sz >= 50:
        s += 15
    if p.get("yearsActive", 0) >= 3:
        s += 10
    if p.get("payrollSystem", "") in ["SAP", "Aspel NOI", "Oracle HCM"]:
        s += 10
    if p.get("satStatus", "") == "active":
        s += 10
    if sz < 5:
        s -= 20
    if p.get("yearsActive", 0) < 1:
        s -= 25
    s = max(0, min(100, s))
    tier = 1 if s >= 70 else (2 if s >= 40 else 3)
    return {"score": s, "risk_tier": tier, "reject": tier == 3, "model": "rule_based"}


def employee_score(p):
    sal = p.get("monthlySalary", 0)
    tier = p.get("employerTier", 2)
    s = 50
    if sal >= 20000:
        s += 15
    elif sal >= 12000:
        s += 8
    if tier == 1:
        s += 15
    elif tier == 2:
        s += 5
    if p.get("existingLoans", 0) > 0:
        s -= 30
    if p.get("bankClabe"):
        s += 10
    s = max(0, min(100, s))
    limit = min(5000, round(sal * 0.30 / 100) * 100)
    return {
        "credit_score": s,
        "recommended_limit": limit,
        "default_probability": round(max(0.01, (100 - s) / 200), 3),
        "model": "rule_based",
    }


def fraud_score(p):
    sc = 0
    if p.get("requestsLastHour", 0) > 2:
        sc += 50
    if p.get("amountToSalaryRatio", 0) > 0.35:
        sc += 20
    return {"anomaly_score": min(100, sc), "is_fraud": sc >= 50}


# ── Stage 4: MetaMap autoencoder-based anomaly detection ─────────────────────

_anomaly_detector = None


def _get_anomaly_detector():
    """Lazy-load the autoencoder anomaly detector."""
    global _anomaly_detector
    if _anomaly_detector is None:
        import os
        from models.autoencoder import AnomalyDetector
        model_path = os.environ.get(
            "AUTOENCODER_MODEL_PATH",
            os.path.join(os.path.dirname(__file__), "models", "autoencoder_v2_metamap.pt"),
        )
        _anomaly_detector = AnomalyDetector.load(model_path)
    return _anomaly_detector


def parse_device_signals(raw: dict) -> dict:
    """
    Extract the 7 MetaMap device signal features from raw request data.

    Accepts either a flat dict with feature names or a nested 'deviceSignals'
    key from the loan request payload.
    """
    signals = raw.get("deviceSignals", raw)
    return {
        "emulator_detected": float(signals.get("emulator_detected", 0)),
        "vpn_detected": float(signals.get("vpn_detected", 0)),
        "rooted_device": float(signals.get("rooted_device", 0)),
        "device_age_days": float(signals.get("device_age_days", 0)),
        "ip_reputation_score": float(signals.get("ip_reputation_score", 50)),
        "session_duration_seconds": float(signals.get("session_duration_seconds", 300)),
        "interaction_anomaly_score": float(signals.get("interaction_anomaly_score", 0)),
    }


def device_fraud_score(p: dict) -> dict:
    """
    Stage 4 behavioral fraud detection using MetaMap autoencoder.

    Combines rule-based fraud_score with autoencoder anomaly detection
    on the 7 MetaMap device signal features.
    """
    # Rule-based component
    rules = fraud_score(p)

    # Autoencoder component
    device_signals = parse_device_signals(p)
    try:
        detector = _get_anomaly_detector()
        ae_result = detector.predict(device_signals)
    except Exception:
        # Graceful degradation: if model unavailable, rely on rules only
        ae_result = {"reconstruction_error": 0.0, "is_anomaly": False, "threshold": 0.0}

    # Combined decision: flag as fraud if either rules OR autoencoder triggers
    is_fraud = rules["is_fraud"] or ae_result["is_anomaly"]

    return {
        "anomaly_score": rules["anomaly_score"],
        "is_fraud": is_fraud,
        "autoencoder": ae_result,
        "device_signals": device_signals,
    }
