"""
BullMQ consumer for the 'vida-underwriting' queue.

NOT currently on the live decision path (see #428,
docs/adr/ADR-004-underwriting-worker-not-the-decision-path.md). Nothing in
this repo enqueues jobs onto 'vida-underwriting', and this module's
__main__ / start_worker() is never invoked in production: the ml-service
Dockerfile only runs `uvicorn main:app`. The live, synchronous decision path
is functions/src/index.ts -> services/underwriting-service (decision-engine.js).

If it were running, a job would run both the champion (WoE scorecard) and
challenger (XGBoost) models, write the champion's decision to Firestore, log
the challenger's prediction for shadow comparison, and push follow-up jobs.

Queue name matches shared/queues.js: QUEUES.UNDERWRITING = 'vida-underwriting'
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

from bullmq import Worker
from redis.asyncio import Redis as AsyncRedis

from typing import Optional

from models.champion_challenger import ModelRouter
from models.isolation_forest import FraudPreScreen
from models.active_learner import HumanReviewRouter
from services.firestore_client import FirestoreClient
from services.softcredito_client import SoftcreditoClient
from monitoring.alerts import alert_model_fallback, alert_rate_limit

logger = logging.getLogger("underwriting_worker")

QUEUE_NAME = "vida-underwriting"
APPROVAL_THRESHOLD = float(os.environ.get("APPROVAL_THRESHOLD", "0.65"))
CHAMPION_PATH = os.environ.get("CHAMPION_MODEL_PATH", "models/scorecard_champion_v2.joblib")
CHALLENGER_PATH = os.environ.get("CHALLENGER_MODEL_PATH", "models/xgb_challenger_v2.joblib")
ISOLATION_FOREST_PATH = os.environ.get("ISOLATION_FOREST_PATH", "models/isolation_forest_v1.joblib")
ACTIVE_LEARNER_PATH = os.environ.get("ACTIVE_LEARNER_PATH", "models/active_learner_v1.joblib")

# Initialised lazily so the module can be imported without creds present
_router: Optional[ModelRouter] = None
_fraud_prescreen: Optional[FraudPreScreen] = None
_human_review_router: Optional[HumanReviewRouter] = None
_firestore: Optional[FirestoreClient] = None
_executor = ThreadPoolExecutor(max_workers=10)


def get_router() -> ModelRouter:
    global _router
    if _router is None:
        _router = ModelRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        logger.info(
            "Loaded champion/challenger router: champion=%s, challenger=%s",
            _router.champion.version,
            _router.challenger.version,
        )
    return _router


def get_fraud_prescreen() -> Optional[FraudPreScreen]:
    """Load Stage 0 Isolation Forest (optional — graceful degradation)."""
    global _fraud_prescreen
    if _fraud_prescreen is None:
        try:
            _fraud_prescreen = FraudPreScreen.load(ISOLATION_FOREST_PATH)
            logger.info("Loaded fraud pre-screen: %s", _fraud_prescreen.version)
        except FileNotFoundError:
            logger.warning("Isolation Forest model not found at %s — skipping Stage 0", ISOLATION_FOREST_PATH)
    return _fraud_prescreen


def get_human_review_router() -> Optional[HumanReviewRouter]:
    """Load Stage 5 active learner (optional — graceful degradation)."""
    global _human_review_router
    if _human_review_router is None:
        try:
            _human_review_router = HumanReviewRouter.load(ACTIVE_LEARNER_PATH)
            logger.info("Loaded active learner: %s", _human_review_router.version)
        except FileNotFoundError:
            logger.warning("Active learner model not found at %s — skipping Stage 5 routing", ACTIVE_LEARNER_PATH)
    return _human_review_router


def get_firestore() -> FirestoreClient:
    global _firestore
    if _firestore is None:
        _firestore = FirestoreClient()
    return _firestore


# ── Encoding helpers ──────────────────────────────────────────────────────────

def encode_pay_freq(freq: str) -> int:
    return {"weekly": 4, "biweekly": 2, "monthly": 1}.get((freq or "").lower(), 1)


def encode_industry(industry: str) -> int:
    codes = {
        "manufacturing": 1,
        "logistics": 2,
        "retail": 3,
        "technology": 4,
        "healthcare": 5,
        "construction": 6,
        "food_beverage": 7,
        "automotive": 8,
    }
    return codes.get((industry or "").lower(), 0)


def get_rejection_reason(score: float, features: dict) -> str:
    if features.get("employment_tenure_months", 0) < 3:
        return "Minimum 3 months employment tenure required"
    if features.get("loan_to_salary_ratio", 0) > 0.30:
        return "Loan amount exceeds 30% of monthly salary"
    if score < 0.40:
        return "Credit risk too high based on employment profile"
    return "Does not meet current lending criteria"


def build_fraud_prescreen_features(borrower: dict, principal: float, monthly_salary: float) -> dict:
    """Build feature dict for the Stage 0 Isolation Forest pre-screen."""
    return {
        "requests_last_hour": float(borrower.get("requestsLastHour", 0)),
        "amount_to_salary_ratio": principal / max(monthly_salary, 1),
        "device_age_days": float(borrower.get("deviceAgeDays", 365)),
        "ip_reputation_score": float(borrower.get("ipReputationScore", 75)),
        "session_duration_seconds": float(borrower.get("sessionDurationSeconds", 300)),
        "interaction_anomaly_score": float(borrower.get("interactionAnomalyScore", 10)),
        "bureau_inquiries_last_30d": float(borrower.get("bureauInquiriesLast30d", 1)),
        "distinct_ips_last_24h": float(borrower.get("distinctIpsLast24h", 1)),
    }


def build_model_features(borrower: dict, principal: float, monthly_salary: float, bureau: Optional[dict] = None) -> dict:
    """Build the feature dict used by both champion and challenger models."""
    lti = principal / max(monthly_salary, 1)
    tenure = float(borrower.get("employmentTenureMonths", 0))
    industry_code = encode_industry(borrower.get("employerIndustry", ""))

    return {
        # Champion features (WoE scorecard)
        "scDiasAtraso": float(bureau.get("diasAtraso", 0)) if bureau else 0.0,
        "cdcScore": float(bureau.get("riskScore", 500)) if bureau else 500.0,
        "carteraVencida": float(bureau.get("carteraVencida", 0)) if bureau else 0.0,
        "imss_tenure_months": tenure,
        "lti": lti,
        "riskSeal_score": float(borrower.get("riskSealScore", 50)),
        "employer_tier": float(borrower.get("employerTier", 3)),
        "sector_risk": float(borrower.get("sectorRisk", 3)),
        "afore_regularity": float(borrower.get("aforeRegularity", 0.7)),
        "monthly_salary": monthly_salary,
        # Challenger-only features (XGBoost)
        "scCuentasActivas": float(bureau.get("cuentasActivas", 3)) if bureau else 3.0,
        "belvo_cash_flow_avg": float(borrower.get("belvoCashFlowAvg", 15000)),
        "employer_score": float(borrower.get("employerScore", 60)),
        "payroll_regularity": float(borrower.get("payrollRegularity", 0.7)),
        # Legacy features (kept for backward compatibility with hard rules)
        "employment_tenure_months": tenure,
        "loan_to_salary_ratio": lti,
        # Declared in models/underwriting_model.py FEATURE_ORDER and monitored
        # by models/drift_monitor.py FEATURE_NAMES. Neither champion nor
        # challenger read it today, but it must still be emitted here — a
        # feature the monitor can't see gets silently treated as a constant
        # 0.0 ("stable") instead of flagged as unmonitorable. See #463.
        "employer_industry_encoded": float(industry_code),
    }


# ── Core job processor ────────────────────────────────────────────────────────

async def process_underwrite_loan(job, job_token=None):
    """
    Main BullMQ processor called for every job on the vida-underwriting queue.

    job.data schema:
      {
        loanId: str,
        userId: str,
        employerId: str,
        principalAmount: float,
        borrowerSnapshot: {
          employmentTenureMonths: int,
          monthlySalary: float,
          payFrequency: "weekly"|"biweekly"|"semimonthly"|"monthly",
          employerIndustry: str,
          curpHash: str,
          fullName: str,
          riskSealScore: float,
          employerTier: int,
          sectorRisk: int,
          aforeRegularity: float,
          belvoCashFlowAvg: float,
          employerScore: float,
          payrollRegularity: float,
        }
      }
    """
    data = job.data
    loan_id = data["loanId"]
    borrower = data["borrowerSnapshot"]
    principal = float(data["principalAmount"])
    monthly_salary = float(borrower.get("monthlySalary", 1))

    logger.info("[underwriting] Processing loan %s", loan_id)

    # ── 0. Stage 0: Isolation Forest fraud pre-screen ────────────────────────
    fraud_prescreen_result = None
    prescreen = get_fraud_prescreen()
    if prescreen is not None:
        try:
            fraud_features = build_fraud_prescreen_features(borrower, principal, monthly_salary)
            fraud_prescreen_result = prescreen.predict(fraud_features)
            if fraud_prescreen_result["is_fraud"]:
                logger.warning(
                    "[underwriting] Stage 0 FRAUD flag for loan %s (score=%.4f)",
                    loan_id, fraud_prescreen_result["anomaly_score"],
                )
        except Exception as e:
            logger.warning("[underwriting] Stage 0 pre-screen failed for loan %s: %s", loan_id, e)

    # ── 1. Optional bureau enrichment (graceful degradation) ─────────────────
    bureau = None
    try:
        bureau = await SoftcreditoClient().query_bureau(
            curp_hash=borrower.get("curpHash", ""),
            full_name=borrower.get("fullName", ""),
        )
        logger.info("[underwriting] Bureau enrichment ok for loan %s", loan_id)
    except Exception as e:
        logger.warning(
            "[underwriting] Bureau lookup failed for loan %s (%s) — using defaults",
            loan_id, e,
        )
        if "429" in str(e) or "rate limit" in str(e).lower():
            await alert_rate_limit("SoftCredito")

    # ── 2. Build feature vector ───────────────────────────────────────────────
    features = build_model_features(borrower, principal, monthly_salary, bureau)

    # ── 3. Run champion/challenger models ─────────────────────────────────────
    router = get_router()
    result = router.predict(features, threshold=APPROVAL_THRESHOLD)

    decision = result["decision"]
    champion_score = result["champion_score"]
    challenger_score = result["challenger_score"]
    shap_top5 = result["shap_top5"]

    # Check if challenger outperforms champion (model fallback signal)
    challenger_alert = router.check_challenger_alert()
    if challenger_alert:
        await alert_model_fallback(
            f"Challenger outperforms champion: Gini delta={challenger_alert['delta']:.4f} "
            f"(n={challenger_alert['sample_size']})"
        )

    rejection_reason = None if decision == "approved" else get_rejection_reason(champion_score, features)

    # ── 4. Hard business rule overrides ──────────────────────────────────────
    if features["employment_tenure_months"] < 3:
        decision = "rejected"
        rejection_reason = "Minimum 3 months employment tenure required"

    # Stage 0 override: reject if Isolation Forest flagged as fraud
    if fraud_prescreen_result and fraud_prescreen_result["is_fraud"] and decision != "rejected":
        decision = "rejected"
        rejection_reason = "Flagged by Stage 0 fraud pre-screen"

    # ── 4.5 ML_MODE override (VID3-712) ──────────────────────────────────────
    from ml_mode import apply_ml_mode_override, get_ml_mode
    _original_decision = decision
    decision = apply_ml_mode_override(decision)
    if decision != _original_decision:
        logger.info(
            "[underwriting] ML_MODE=%s overrode decision: %s → %s (loan %s)",
            get_ml_mode(), _original_decision, decision, loan_id,
        )
        rejection_reason = None  # not a rejection, just routed for review

    # ── 5. Stage 5: Active learning human-review routing ─────────────────────
    route_to_human = False
    human_review_router = get_human_review_router()
    if human_review_router is not None and decision == "approved":
        try:
            import numpy as _np
            feature_vector = _np.array([
                features.get(f, 0.0) for f in [
                    "scDiasAtraso", "cdcScore", "carteraVencida",
                    "imss_tenure_months", "lti", "riskSeal_score",
                    "employer_tier", "sector_risk", "afore_regularity",
                    "monthly_salary",
                ]
            ], dtype=_np.float64)
            review_result = human_review_router.should_route_to_human(feature_vector)
            route_to_human = review_result["route_to_human"]
            if route_to_human:
                decision = "manual_review"
                rejection_reason = None
                logger.info(
                    "[underwriting] Loan %s routed to human review (uncertainty=%.4f)",
                    loan_id, review_result["uncertainty"],
                )
        except Exception as e:
            logger.warning("[underwriting] Stage 5 routing failed for loan %s: %s", loan_id, e)

    logger.info(
        "[underwriting] Loan %s → %s (champion=%.3f, challenger=%.3f, threshold=%.2f)",
        loan_id, decision, champion_score, challenger_score, APPROVAL_THRESHOLD,
    )

    # ── 5. Write decision to Firestore (blocking SDK → run in executor) ───────
    now_iso = datetime.now(timezone.utc).isoformat()
    firestore = get_firestore()

    update_payload = {
        "status": decision,
        "underwritingScore": champion_score,
        "underwritingDecision": decision,
        "underwritingModel": result["champion_model"],
        "challengerModel": result["challenger_model"],
        "challengerScore": challenger_score,
        "shapTop5": shap_top5,
        "rejectionReason": rejection_reason,
        "fraudPrescreen": fraud_prescreen_result,
        "routedToHumanReview": route_to_human,
        "updatedAt": now_iso,
        "statusHistory": firestore.array_union({
            "from": "pending",
            "to": decision,
            "at": now_iso,
            "by": "system",
            "reason": f"Champion {result['champion_model']}: score={champion_score:.3f}",
        }),
    }

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        _executor,
        lambda: firestore.update_loan(loan_id, update_payload),
    )

    # ── 6. Check challenger alert ─────────────────────────────────────────────
    alert = router.check_challenger_alert()
    if alert:
        logger.warning("[underwriting] Challenger outperformance alert: %s", alert)

    # ── 7. Push downstream jobs via Redis ────────────────────────────────────
    redis = AsyncRedis.from_url(
        os.environ["REDIS_URL"],
        decode_responses=True,
        ssl_cert_reqs=None if os.environ.get("REDIS_URL", "").startswith("rediss://") else None,
    )
    try:
        if decision == "approved":
            await redis.lpush(
                "jobs:disbursements",
                json.dumps({
                    "type": "disburse_loan",
                    "loanId": loan_id,
                    "userId": data.get("userId"),
                    "amount": principal,
                }),
            )

        await redis.lpush(
            "jobs:notifications",
            json.dumps({
                "type": f"loan_{decision}",
                "userId": data.get("userId"),
                "loanId": loan_id,
                "score": champion_score,
                "challengerScore": challenger_score,
                "rejectionReason": rejection_reason,
            }),
        )
    finally:
        await redis.aclose()

    logger.info("[underwriting] Loan %s complete: %s", loan_id, decision)
    return {
        "decision": decision,
        "score": champion_score,
        "challengerScore": challenger_score,
        "shapTop5": shap_top5,
    }


# ── Worker entry point ────────────────────────────────────────────────────────

async def start_worker():
    redis_url = os.environ["REDIS_URL"]
    logger.info("[ml-service] Starting underwriting worker on queue '%s'", QUEUE_NAME)

    worker = Worker(
        QUEUE_NAME,
        process_underwrite_loan,
        {
            "connection": redis_url,
            "concurrency": 5,
            "stalledInterval": 30_000,
            "maxStalledCount": 1,
        },
    )
    logger.info("[ml-service] Underwriting worker running (concurrency=5)")
    await worker.run()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_worker())
