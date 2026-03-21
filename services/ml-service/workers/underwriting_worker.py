"""
BullMQ consumer for the 'vida-underwriting' queue.

Processes 'underwrite_loan' jobs dispatched by the requestLoan Firebase
Function. Runs champion (WoE scorecard) and challenger (XGBoost) models,
applies hard business rules, writes the decision to Firestore, then pushes
follow-up jobs to Redis lists for the disbursement and notification services.

Queue name matches shared/queues.js: QUEUES.UNDERWRITING = 'vida-underwriting'
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from bullmq import Worker
from redis.asyncio import Redis as AsyncRedis

from models.underwriting_model import UnderwritingModel
from models.scorecard_model import ScorecardModel
from models.xgb_model import XGBoostChallengerModel
from models.router import ChampionChallengerRouter
from services.firestore_client import FirestoreClient
from services.softcredito_client import SoftcreditoClient

logger = logging.getLogger("underwriting_worker")

QUEUE_NAME = "vida-underwriting"
APPROVAL_THRESHOLD = float(os.environ.get("APPROVAL_THRESHOLD", "0.65"))
MODEL_PATH = os.environ.get("MODEL_PATH", "models/underwriting_v1.joblib")
CHAMPION_PATH = os.environ.get("CHAMPION_MODEL_PATH", "models/scorecard_champion_v2.joblib")
CHALLENGER_PATH = os.environ.get("CHALLENGER_MODEL_PATH", "models/xgb_challenger_v2.joblib")

# Initialised lazily so the module can be imported without creds present
_model: Optional[UnderwritingModel] = None
_router: Optional[ChampionChallengerRouter] = None
_firestore: Optional[FirestoreClient] = None
_executor = ThreadPoolExecutor(max_workers=10)


def get_model() -> UnderwritingModel:
    global _model
    if _model is None:
        _model = UnderwritingModel.load(MODEL_PATH)
        logger.info("Loaded underwriting model v1 from %s", MODEL_PATH)
    return _model


def get_router() -> ChampionChallengerRouter | None:
    """Load champion/challenger router. Returns None if model files are missing."""
    global _router
    if _router is None:
        try:
            _router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
            logger.info(
                "Loaded champion/challenger router: champion=%s challenger=%s",
                _router.champion.version, _router.challenger.version,
            )
        except FileNotFoundError as e:
            logger.warning("Champion/challenger models not found (%s) — using v1 fallback", e)
            return None
    return _router


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


SECTOR_RISK_MAP = {
    "manufacturing": 0.3,
    "logistics": 0.4,
    "retail": 0.5,
    "technology": 0.2,
    "healthcare": 0.2,
    "construction": 0.6,
    "food_beverage": 0.5,
    "automotive": 0.3,
}


def get_rejection_reason(score: float, features: dict) -> str:
    if features.get("employment_tenure_months", 0) < 3:
        return "Minimum 3 months employment tenure required"
    if features.get("loan_to_salary_ratio", 0) > 0.30:
        return "Loan amount exceeds 30% of monthly salary"
    if score < 0.40:
        return "Credit risk too high based on employment profile"
    return "Does not meet current lending criteria"


def build_v2_features(borrower: dict, principal: float, monthly_salary: float, bureau: dict | None) -> dict:
    """Build the expanded feature set for champion/challenger models."""
    industry = (borrower.get("employerIndustry") or "").lower()
    tenure = float(borrower.get("employmentTenureMonths", 0))

    return {
        # Champion features (WoE scorecard)
        "scDiasAtraso": float(bureau.get("diasAtraso", 0)) if bureau else 0.0,
        "cdcScore": float(bureau.get("riskScore", 500)) if bureau else 500.0,
        "carteraVencida": float(bureau.get("carteraVencida", 0)) if bureau else 0.0,
        "imss_tenure_months": tenure,
        "lti": principal / max(monthly_salary, 1),
        "riskSeal_score": float(borrower.get("riskSealScore", 50)),
        "employer_tier": float(borrower.get("employerTier", 2)),
        "sector_risk": SECTOR_RISK_MAP.get(industry, 0.5),
        "afore_regularity": float(borrower.get("aforeRegularity", 0.5)),
        "monthly_salary": monthly_salary,
        # Challenger-only features
        "scCuentasActivas": float(bureau.get("cuentasActivas", 0)) if bureau else 0.0,
        "belvo_cash_flow_avg": float(borrower.get("belvoCashFlowAvg", 0)),
        "employer_score": float(borrower.get("employerScore", 50)),
        "payroll_regularity": float(borrower.get("payrollRegularity", 0.5)),
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
          payFrequency: "weekly"|"biweekly"|"monthly",
          employerIndustry: str,
          curpHash: str,
          fullName: str,
          // v2 fields (optional, gracefully degraded):
          riskSealScore: float,
          employerTier: int,
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

    # ── 1. Build v1 feature vector (always needed for fallback) ────────────
    v1_features = {
        "employment_tenure_months": float(borrower.get("employmentTenureMonths", 0)),
        "monthly_salary": monthly_salary,
        "pay_frequency_encoded": float(encode_pay_freq(borrower.get("payFrequency", "monthly"))),
        "loan_to_salary_ratio": principal / max(monthly_salary, 1),
        "employer_industry_encoded": float(encode_industry(borrower.get("employerIndustry", ""))),
        "principal_amount": principal,
        "bureau_score": 500.0,
        "has_bureau_record": 0.0,
    }

    # ── 2. Optional bureau enrichment (graceful degradation) ─────────────
    bureau = None
    try:
        bureau = await SoftcreditoClient().query_bureau(
            curp_hash=borrower.get("curpHash", ""),
            full_name=borrower.get("fullName", ""),
        )
        v1_features["bureau_score"] = float(bureau.get("riskScore", 500))
        v1_features["has_bureau_record"] = 1.0 if bureau.get("found") else 0.0
        logger.info("[underwriting] Bureau enrichment ok for loan %s: score=%s", loan_id, v1_features["bureau_score"])
    except Exception as e:
        logger.warning(
            "[underwriting] Bureau lookup failed for loan %s (%s) — using defaults",
            loan_id, e,
        )

    # ── 3. Run models ──────────────────────────────────────────────────────
    router = get_router()
    shap_top5 = []
    challenger_prob = None
    challenger_model = None

    if router is not None:
        # v2 champion/challenger path
        v2_features = build_v2_features(borrower, principal, monthly_salary, bureau)
        result = router.predict(v2_features)

        prob_repayment = result["champion_prob"]
        model_version = result["champion_model"]
        challenger_prob = result["challenger_prob"]
        challenger_model = result["challenger_model"]
        shap_top5 = result["shap_top5"]
    else:
        # v1 fallback path
        model = get_model()
        prob_repayment = model.predict_proba(v1_features)
        model_version = "logistic_v1.0"

    decision = "approved" if prob_repayment >= APPROVAL_THRESHOLD else "rejected"
    rejection_reason = None if decision == "approved" else get_rejection_reason(prob_repayment, v1_features)

    # ── 4. Hard business rule overrides ──────────────────────────────────
    if v1_features["employment_tenure_months"] < 3:
        decision = "rejected"
        rejection_reason = "Minimum 3 months employment tenure required"

    logger.info(
        "[underwriting] Loan %s → %s (score=%.3f, threshold=%.2f, model=%s)",
        loan_id, decision, prob_repayment, APPROVAL_THRESHOLD, model_version,
    )

    # ── 5. Write decision to Firestore (blocking SDK → run in executor) ───────
    now_iso = datetime.now(timezone.utc).isoformat()
    firestore = get_firestore()

    update_payload = {
        "status": decision,
        "underwritingScore": round(prob_repayment, 4),
        "underwritingDecision": decision,
        "underwritingModel": model_version,
        "rejectionReason": rejection_reason,
        "updatedAt": now_iso,
        "statusHistory": firestore.array_union({
            "from": "pending",
            "to": decision,
            "at": now_iso,
            "by": "system",
            "reason": f"Underwriting model {model_version}: score={prob_repayment:.3f}",
        }),
    }

    # Store SHAP top-5 for adverse action notices
    if shap_top5:
        update_payload["shapTop5"] = shap_top5

    # Store challenger shadow prediction for offline comparison
    if challenger_prob is not None:
        update_payload["challengerScore"] = round(challenger_prob, 4)
        update_payload["challengerModel"] = challenger_model

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        _executor,
        lambda: firestore.update_loan(loan_id, update_payload),
    )

    # ── 6. Push downstream jobs via Redis ────────────────────────────────
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

    logger.info("[underwriting] Loan %s complete: %s", loan_id, decision)
    return {"decision": decision, "score": round(prob_repayment, 4)}


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
