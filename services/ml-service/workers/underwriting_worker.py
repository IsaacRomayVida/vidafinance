"""
BullMQ consumer for the 'vida-underwriting' queue.

Processes 'underwrite_loan' jobs dispatched by the requestLoan Firebase
Function. Each job runs the logistic regression model, applies hard
business rules, writes the decision to Firestore, then pushes follow-up
jobs to Redis lists for the disbursement and notification services.

Queue name matches shared/queues.js: QUEUES.UNDERWRITING = 'vida-underwriting'
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

import structlog
from bullmq import Worker
from redis.asyncio import Redis as AsyncRedis

from models.underwriting_model import UnderwritingModel
from services.firestore_client import FirestoreClient
from services.softcredito_client import SoftcreditoClient

logging.basicConfig(level=logging.INFO, format="%(message)s")
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
)
logger = structlog.get_logger("underwriting_worker")

QUEUE_NAME = "vida-underwriting"
APPROVAL_THRESHOLD = float(os.environ.get("APPROVAL_THRESHOLD", "0.65"))
MODEL_PATH = os.environ.get("MODEL_PATH", "models/underwriting_v1.joblib")

# Initialised lazily so the module can be imported without creds present
_model: UnderwritingModel | None = None
_firestore: FirestoreClient | None = None
_executor = ThreadPoolExecutor(max_workers=10)


def get_model() -> UnderwritingModel:
    global _model
    if _model is None:
        _model = UnderwritingModel.load(MODEL_PATH)
        logger.info("Loaded underwriting model v1", model_path=MODEL_PATH, service="ml-service")
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
          payFrequency: "weekly"|"biweekly"|"monthly",
          employerIndustry: str,
          curpHash: str,
          fullName: str,
        }
      }
    """
    data = job.data
    loan_id = data["loanId"]
    correlation_id = data.get("correlationId")
    borrower = data["borrowerSnapshot"]
    principal = float(data["principalAmount"])
    monthly_salary = float(borrower.get("monthlySalary", 1))

    log = logger.bind(correlation_id=correlation_id, loan_id=loan_id, service="ml-service")
    log.info("Processing underwriting job")

    # ── 1. Build feature vector ───────────────────────────────────────────────
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

    # ── 2. Optional bureau enrichment (graceful degradation) ─────────────────
    try:
        bureau = await SoftcreditoClient().query_bureau(
            curp_hash=borrower.get("curpHash", ""),
            full_name=borrower.get("fullName", ""),
        )
        features["bureau_score"] = float(bureau.get("riskScore", 500))
        features["has_bureau_record"] = 1.0 if bureau.get("found") else 0.0
        log.info("Bureau enrichment ok", bureau_score=features["bureau_score"])
    except Exception as e:
        log.warning("Bureau lookup failed — using defaults", error=str(e))

    # ── 3. Run model ──────────────────────────────────────────────────────────
    model = get_model()
    prob_repayment = model.predict_proba(features)
    decision = "approved" if prob_repayment >= APPROVAL_THRESHOLD else "rejected"
    rejection_reason = None if decision == "approved" else get_rejection_reason(prob_repayment, features)

    # ── 4. Hard business rule overrides ──────────────────────────────────────
    if features["employment_tenure_months"] < 3:
        decision = "rejected"
        rejection_reason = "Minimum 3 months employment tenure required"

    log.info(
        "Underwriting decision",
        decision=decision,
        score=round(prob_repayment, 4),
        threshold=APPROVAL_THRESHOLD,
    )

    # ── 5. Write decision to Firestore (blocking SDK → run in executor) ───────
    now_iso = datetime.now(timezone.utc).isoformat()
    firestore = get_firestore()

    update_payload = {
        "status": decision,
        "underwritingScore": round(prob_repayment, 4),
        "underwritingDecision": decision,
        "underwritingModel": "logistic_v1.0",
        "rejectionReason": rejection_reason,
        "updatedAt": now_iso,
        "statusHistory": firestore.array_union({
            "from": "pending",
            "to": decision,
            "at": now_iso,
            "by": "system",
            "reason": f"Underwriting model v1.0: score={prob_repayment:.3f}",
        }),
    }

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        _executor,
        lambda: firestore.update_loan(loan_id, update_payload),
    )

    # ── 6. Push downstream jobs via Redis ────────────────────────────────────
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
                "score": round(prob_repayment, 4),
                "rejectionReason": rejection_reason,
            }),
        )
    finally:
        await redis.aclose()

    log.info("Underwriting job complete", decision=decision)
    return {"decision": decision, "score": round(prob_repayment, 4)}


# ── Worker entry point ────────────────────────────────────────────────────────

async def start_worker():
    redis_url = os.environ["REDIS_URL"]
    logger.info("Starting underwriting worker", queue=QUEUE_NAME, service="ml-service")

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
    logger.info("Underwriting worker running", concurrency=5, service="ml-service")
    await worker.run()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_worker())
