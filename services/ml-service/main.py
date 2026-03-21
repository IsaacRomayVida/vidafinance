import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Header
import os, json, time
import redis as Redis
from dotenv import load_dotenv

load_dotenv()
from scoring import employer_score, employee_score, fraud_score

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-service")

rdb = Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True
)
SEC = os.environ.get("INTERNAL_SECRET", "")
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTL = int(os.environ.get("ML_CACHE_TTL", "86400"))

_worker_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker_task
    has_firebase = os.environ.get("FIREBASE_SERVICE_ACCOUNT") or os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64")
    if os.environ.get("REDIS_URL") and has_firebase:
        try:
            from workers.underwriting_worker import start_worker
            _worker_task = asyncio.create_task(start_worker())
            logger.info("Underwriting worker task started")
        except Exception as e:
            logger.warning("Could not start underwriting worker: %s", e)
    else:
        logger.warning(
            "Underwriting worker not started: REDIS_URL or Firebase credentials missing"
        )
    yield
    if _worker_task and not _worker_task.done():
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        logger.info("Underwriting worker stopped")


app = FastAPI(title="vida-ml-service", lifespan=lifespan)


def auth(s):
    if s != SEC:
        raise HTTPException(401, "Unauthorized")


@app.get("/health")
def health():
    try:
        rdb.ping()
        r = True
    except Exception:
        r = False
    worker_alive = _worker_task is not None and not _worker_task.done()
    return {
        "status": "ok" if r else "degraded",
        "service": "vida-ml-service",
        "redis": r,
        "worker": "running" if worker_alive else "stopped",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/underwrite/employer")
async def score_emp(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    uid = payload.get("employerUid", "")
    ck = f"ml:employer:{uid}"
    try:
        c = rdb.get(ck)
        if c:
            return json.loads(c)
    except Exception:
        pass
    result = employer_score(payload)
    llm = {
        "risk_tier": result["risk_tier"],
        "red_flags": [],
        "green_flags": [],
        "escalate_to_human": False,
        "summary": "Rule-based",
    }
    if AKEY:
        try:
            import anthropic

            client = anthropic.Anthropic(api_key=AKEY)
            msg = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=400,
                system="Credit risk analyst for VIDA Finance Mexico SOFOM. Respond ONLY with valid JSON.",
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f'Analyze employer risk. Company:{payload.get("companyName","?")} '
                            f'Size:{payload.get("companySize","?")} Industry:{payload.get("industry","?")} '
                            f'Payroll:{payload.get("payrollSystem","?")} Years:{payload.get("yearsActive","?")}\n'
                            'Respond: {"risk_tier":1|2|3,"red_flags":[],"green_flags":[],'
                            '"escalate_to_human":true|false,"summary":"1 sentence"}'
                        ),
                    }
                ],
            )
            llm = json.loads(msg.content[0].text)
        except Exception as e:
            print("LLM error:", e)
    final = {
        **result,
        "llm_analysis": llm,
        "fraud": fraud_score({}),
        "shap": [],
        "decisionId": f"{uid}_{int(time.time())}",
        "ts": int(time.time()),
    }
    try:
        rdb.setex(ck, TTL, json.dumps(final))
    except Exception:
        pass
    return final


@app.post("/underwrite/employee")
async def score_employee(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    uid = payload.get("employeeId", "")
    amt = payload.get("amount", 0)
    ck = f"ml:employee:{uid}:{amt}"
    try:
        c = rdb.get(ck)
        if c:
            return json.loads(c)
    except Exception:
        pass
    fd = fraud_score(
        {
            "requestsLastHour": payload.get("requestsLastHour", 0),
            "amountToSalaryRatio": amt / max(payload.get("monthlySalary", 1), 1),
        }
    )
    result = employee_score(payload)
    final = {
        **result,
        "fraud": fd,
        "shap": [],
        "decisionId": f"{uid}_{int(time.time())}",
        "ts": int(time.time()),
    }
    try:
        rdb.setex(ck, 3600, json.dumps(final))
    except Exception:
        pass
    return final


@app.get("/explain/{decision_id}")
def explain(decision_id: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {
        "decisionId": decision_id,
        "shap": [],
        "message": "Full SHAP after model training (200+ loans)",
    }


@app.post("/monitor/drift")
def drift(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {
        "drift_detected": False,
        "psi_scores": {},
        "message": "Active after first model training",
    }


@app.delete("/cache/employer/{uid}")
def clear_cache(uid: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    try:
        rdb.delete(f"ml:employer:{uid}")
    except Exception:
        pass
    return {"cleared": f"ml:employer:{uid}"}


@app.post("/score")
async def score_loan_direct(
    payload: dict, x_internal_secret: str = Header(None)
):
    """
    Direct synchronous scoring endpoint.
    Accepts the same payload as the BullMQ job data so other services
    can call underwriting synchronously without going through the queue.

    Runs champion/challenger models when available, falls back to v1.
    """
    auth(x_internal_secret)
    from workers.underwriting_worker import (
        encode_pay_freq,
        encode_industry,
        get_rejection_reason,
        get_router,
        build_v2_features,
        APPROVAL_THRESHOLD,
    )
    from models.underwriting_model import UnderwritingModel
    import os as _os

    borrower = payload.get("borrowerSnapshot", {})
    principal = float(payload.get("principalAmount", 0))
    monthly_salary = float(borrower.get("monthlySalary", 1))

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

    router = get_router()
    if router is not None:
        v2_features = build_v2_features(borrower, principal, monthly_salary, None)
        result = router.predict(v2_features)
        prob = result["champion_prob"]
        model_name = result["champion_model"]
        decision = "approved" if prob >= APPROVAL_THRESHOLD else "rejected"

        if v1_features["employment_tenure_months"] < 3:
            decision = "rejected"

        return {
            "decision": decision,
            "score": round(prob, 4),
            "threshold": APPROVAL_THRESHOLD,
            "model": model_name,
            "challenger_score": round(result["challenger_prob"], 4),
            "challenger_model": result["challenger_model"],
            "champion_scorecard_points": result["champion_score"],
            "shap_top5": result["shap_top5"],
        }

    model_path = _os.environ.get("MODEL_PATH", "models/underwriting_v1.joblib")
    model = UnderwritingModel.load(model_path)
    prob = model.predict_proba(v1_features)
    decision = "approved" if prob >= APPROVAL_THRESHOLD else "rejected"

    if v1_features["employment_tenure_months"] < 3:
        decision = "rejected"

    return {
        "decision": decision,
        "score": round(prob, 4),
        "threshold": APPROVAL_THRESHOLD,
        "model": "logistic_v1.0",
    }


@app.get("/models/status")
def model_status(x_internal_secret: str = Header(None)):
    """Return the current champion/challenger model status and promotion check."""
    auth(x_internal_secret)
    from workers.underwriting_worker import get_router

    router = get_router()
    if router is None:
        return {
            "champion": "logistic_v1.0",
            "challenger": None,
            "promotion": None,
        }

    promotion = router.check_promotion()
    return {
        "champion": router.champion.version,
        "challenger": router.challenger.version,
        "promotion": promotion,
    }
