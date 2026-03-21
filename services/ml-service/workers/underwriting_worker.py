"""
BullMQ consumer for the 'vida-underwriting' queue.

Coordinates underwriting decisions by calling the decision-engine HTTP
service for the full 6-stage pipeline.  Falls back to the local logistic
regression model when the decision engine is unreachable.

Queue name matches shared/queues.js: QUEUES.UNDERWRITING = 'vida-underwriting'
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

import httpx
from bullmq import Worker
from redis.asyncio import Redis as AsyncRedis

from models.underwriting_model import UnderwritingModel
from services.firestore_client import FirestoreClient
from services.softcredito_client import SoftcreditoClient

logger = logging.getLogger("underwriting_worker")

QUEUE_NAME = "vida-underwriting"
APPROVAL_THRESHOLD = float(os.environ.get("APPROVAL_THRESHOLD", "0.65"))
MODEL_PATH = os.environ.get("MODEL_PATH", "models/underwriting_v1.joblib")
DECISION_ENGINE_URL = os.environ.get(
    "DECISION_ENGINE_URL",
    "http://vida-underwriting.railway.internal:3003",
)
DECISION_ENGINE_TIMEOUT = float(os.environ.get("DECISION_ENGINE_TIMEOUT", "30"))

# Initialised lazily so the module can be imported without creds present
_model = None  # type: UnderwritingModel | None
_firestore = None  # type: FirestoreClient | None
_executor = ThreadPoolExecutor(max_workers=10)


def get_model() -> UnderwritingModel:
    global _model
    if _model is None:
        _model = UnderwritingModel.load(MODEL_PATH)
        logger.info("Loaded underwriting model v1 from %s", MODEL_PATH)
    return _model


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


# ── Decision engine caller ────────────────────────────────────────────────────

async def call_decision_engine(data: dict) -> dict:
    """Call the decision-engine HTTP service for the full 6-stage pipeline.

    Returns the engine response dict on success, or raises on failure.
    """
    url = f"{DECISION_ENGINE_URL}/pipeline"
    async with httpx.AsyncClient(timeout=DECISION_ENGINE_TIMEOUT) as client:
        resp = await client.post(url, json=data)
        resp.raise_for_status()
        return resp.json()


# ── Local model fallback ─────────────────────────────────────────────────────

async def run_local_model_fallback(data: dict) -> dict:
    """Run the original logistic regression model as a fallback.

    Returns a dict shaped like the decision-engine response so downstream
    code can treat both paths uniformly.
    """
    borrower = data["borrowerSnapshot"]
    principal = float(data["principalAmount"])
    monthly_salary = float(borrower.get("monthlySalary", 1))

    features = {
        "employment_tenure_months": float(borrower.get("employmentTenureMonths", 0)),
        "monthly_salary": monthly_salary,
        "pay_frequency_encoded": float(encode_pay_freq(borrower.get("payFrequency", "monthly"))),
        "loan_to_salary_ratio": principal / max(monthly_salary, 1),
        "employer_industry_encoded": float(encode_industry(borrower.get("employerIndustry", ""))),
        "principal_amount": principal,
        "bureau_score": 500.0,
        "has_bureau_record": 0.0,
    }

    # Optional bureau enrichment (graceful degradation)
    try:
        bureau = await SoftcreditoClient().query_bureau(
            curp_hash=borrower.get("curpHash", ""),
            full_name=borrower.get("fullName", ""),
        )
        features["bureau_score"] = float(bureau.get("riskScore", 500))
        features["has_bureau_record"] = 1.0 if bureau.get("found") else 0.0
    except Exception as e:
        logger.warning("[underwriting] Bureau lookup failed (%s) — using defaults", e)

    model = get_model()
    prob_repayment = model.predict_proba(features)
    decision = "approved" if prob_repayment >= APPROVAL_THRESHOLD else "rejected"
    reason = None if decision == "approved" else get_rejection_reason(prob_repayment, features)

    # Hard business rule override
    if features["employment_tenure_months"] < 3:
        decision = "rejected"
        reason = "Minimum 3 months employment tenure required"

    return {
        "decision": decision,
        "stage": "fallback",
        "reason": reason,
        "score": round(prob_repayment, 4),
        "signals": {},
        "cost": 0.0,
        "model": "logistic_v1.0",
    }


# ── Core job processor ────────────────────────────────────────────────────────

async def process_underwrite_loan(job, job_token=None):
    """
    Main BullMQ processor called for every job on the vida-underwriting queue.

    Acts as a COORDINATOR: calls the decision-engine HTTP service for the
    full 6-stage pipeline, falling back to the local logistic regression
    model if the engine is unreachable.

    job.data schema:
      {
        loanId: str,
        userId: str,
        employerId: str,
        principalAmount: float,
        borrowerSnapshot: {
          employmentTenureMonths: int,
          monthlySalary: float,
          payFrequency: "weekly"|"biweekly"|"monthly",
          employerIndustry: str,
          curpHash: str,
          fullName: str,
        }
      }
    """
    data = job.data
    loan_id = data["loanId"]
    principal = float(data["principalAmount"])
    used_fallback = False

    logger.info("[underwriting] Processing loan %s", loan_id)

    # ── 1. Call decision engine (with fallback) ──────────────────────────────
    try:
        engine_result = await call_decision_engine(data)
        logger.info(
            "[underwriting] Decision engine responded for loan %s: decision=%s, stage=%s",
            loan_id, engine_result.get("decision"), engine_result.get("stage"),
        )
    except Exception as e:
        logger.warning(
            "[underwriting] Decision engine unavailable for loan %s (%s) — falling back to local model",
            loan_id, e,
        )
        engine_result = await run_local_model_fallback(data)
        used_fallback = True

    decision = engine_result["decision"]
    score = engine_result.get("score", 0.0)
    stage = engine_result.get("stage", "unknown")
    reason = engine_result.get("reason")
    signals = engine_result.get("signals", {})
    cost = engine_result.get("cost", 0.0)
    model_name = engine_result.get("model", "decision_engine_v1.0")

    logger.info(
        "[underwriting] Loan %s → %s (score=%.3f, stage=%s, fallback=%s)",
        loan_id, decision, score, stage, used_fallback,
    )

    # ── 2. Write decision to Firestore (blocking SDK → run in executor) ───────
    now_iso = datetime.now(timezone.utc).isoformat()
    firestore = get_firestore()

    update_payload = {
        "status": decision,
        "underwritingScore": round(score, 4),
        "underwritingDecision": decision,
        "underwritingModel": model_name,
        "underwritingStage": stage,
        "underwritingReason": reason,
        "underwritingCost": round(cost, 4),
        "underwritingSignals": signals,
        "rejectionReason": reason,
        "updatedAt": now_iso,
        "statusHistory": firestore.array_union({
            "from": "pending",
            "to": decision,
            "at": now_iso,
            "by": "system",
            "reason": f"{model_name}: score={score:.3f}, stage={stage}",
        }),
        "stageHistory": firestore.array_union({
            "stage": stage,
            "decision": decision,
            "score": round(score, 4),
            "reason": reason,
            "cost": round(cost, 4),
            "usedFallback": used_fallback,
            "at": now_iso,
        }),
    }

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        _executor,
        lambda: firestore.update_loan(loan_id, update_payload),
    )

    # ── 3. Push downstream jobs via Redis ────────────────────────────────────
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
                "score": round(score, 4),
                "rejectionReason": reason,
            }),
        )
    finally:
        await redis.aclose()

    logger.info("[underwriting] Loan %s complete: %s", loan_id, decision)
    return {"decision": decision, "score": round(score, 4)}


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
