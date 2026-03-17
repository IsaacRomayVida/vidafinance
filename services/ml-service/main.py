import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os, json, time
import redis as Redis
from dotenv import load_dotenv

load_dotenv()
from scoring import employer_score, employee_score, fraud_score
from pipeline import run_pipeline, run_scorecard, run_fraud_detection, ApplicationInput

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-service")

rdb = Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True
)
SEC = os.environ.get("INTERNAL_SECRET", "") or os.environ.get("INTERNAL_API_SECRET", "")
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTL = int(os.environ.get("ML_CACHE_TTL", "86400"))

_worker_task: asyncio.Task | None = None

ALLOWED_ORIGINS = [
    "https://vida-staging.web.app",
    "https://vida-finance.web.app",
    "https://admin.vida.finance",
    "https://employer.vida.finance",
]

limiter = Limiter(key_func=get_remote_address)


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

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "x-internal-secret"],
)


def auth(s):
    if not SEC or s != SEC:
        raise HTTPException(401, "Unauthorized")


@app.get("/health")
@limiter.limit("60/minute")
def health(request: Request):
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
@limiter.limit("100/15minutes")
async def score_emp(request: Request, payload: dict, x_internal_secret: str = Header(None)):
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
@limiter.limit("100/15minutes")
async def score_employee(request: Request, payload: dict, x_internal_secret: str = Header(None)):
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
@limiter.limit("100/15minutes")
def explain(request: Request, decision_id: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {
        "decisionId": decision_id,
        "shap": [],
        "message": "Full SHAP after model training (200+ loans)",
    }


@app.post("/monitor/drift")
@limiter.limit("100/15minutes")
def drift(request: Request, payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {
        "drift_detected": False,
        "psi_scores": {},
        "message": "Active after first model training",
    }


@app.delete("/cache/employer/{uid}")
@limiter.limit("100/15minutes")
def clear_cache(request: Request, uid: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    try:
        rdb.delete(f"ml:employer:{uid}")
    except Exception:
        pass
    return {"cleared": f"ml:employer:{uid}"}


@app.post("/underwrite/pipeline")
@limiter.limit("100/15minutes")
async def underwrite_pipeline(request: Request, payload: dict, x_internal_secret: str = Header(None)):
    """Full 6-stage Decision Tree underwriting pipeline (stages 0–5).

    Caches results in Redis by applicant_id + principal_amount (TTL 1 hour).
    """
    auth(x_internal_secret)
    applicant_id = payload.get("applicant_id", "") or payload.get("applicantId", "")
    principal = payload.get("principal_amount", 0) or payload.get("principalAmount", 0)
    ck = f"ml:pipeline:{applicant_id}:{principal}"

    try:
        cached = rdb.get(ck)
        if cached:
            return json.loads(cached)
    except Exception:
        pass

    app_input = ApplicationInput(
        applicant_id=applicant_id,
        curp_hash=payload.get("curp_hash", "") or payload.get("curpHash", ""),
        employment_type=payload.get("employment_type", "imss") or payload.get("employmentType", "imss"),
        employer_type=payload.get("employer_type", "private"),
        employment_tenure_months=int(payload.get("employment_tenure_months", 0) or payload.get("employmentTenureMonths", 0)),
        monthly_salary=float(payload.get("monthly_salary", 0) or payload.get("monthlySalary", 0)),
        pay_frequency=payload.get("pay_frequency", "biweekly") or payload.get("payFrequency", "biweekly"),
        imss_enrolled_months=int(payload.get("imss_enrolled_months", 0)),
        has_afore=bool(payload.get("has_afore", False)),
        principal_amount=float(principal),
        kyc_passed=bool(payload.get("kyc_passed", True)),
        kyc_confidence=float(payload.get("kyc_confidence", 90)),
        bureau_score=payload.get("bureau_score") or payload.get("bureauScore"),
        bureau_inquiry_count=int(payload.get("bureau_inquiry_count", 0)),
        has_bureau_record=bool(payload.get("has_bureau_record", False)),
        device_fingerprint=payload.get("device_fingerprint", ""),
        device_age_days=int(payload.get("device_age_days", 365)),
        requests_last_hour=int(payload.get("requests_last_hour", 0)),
        geo_distance_km=float(payload.get("geo_distance_km", 0)),
        same_ip_applications=int(payload.get("same_ip_applications", 0)),
        time_since_last_app_hours=float(payload.get("time_since_last_app_hours", 720)),
        blacklisted_device=bool(payload.get("blacklisted_device", False)),
        aml_clear=bool(payload.get("aml_clear", True)),
        pep_flag=bool(payload.get("pep_flag", False)),
        employer_industry=payload.get("employer_industry", "") or payload.get("employerIndustry", ""),
        employer_size=payload.get("employer_size", "51-200"),
    )

    pipeline_result = run_pipeline(app_input, anthropic_api_key=AKEY or None)

    output = {
        "applicant_id": pipeline_result.applicant_id,
        "decision": pipeline_result.decision,
        "stage_reached": pipeline_result.stage_reached,
        "stage_name": pipeline_result.stage_name,
        "credit_score": pipeline_result.credit_score,
        "pd_estimate": pipeline_result.pd_estimate,
        "risk_grade": pipeline_result.risk_grade,
        "fraud_score": pipeline_result.fraud_score,
        "rejection_reason": pipeline_result.rejection_reason,
        "approval_conditions": pipeline_result.approval_conditions,
        "models_used": pipeline_result.models_used,
        "processing_time_ms": pipeline_result.processing_time_ms,
        "stage_results": [
            {
                "stage": r.stage,
                "name": r.name,
                "passed": r.passed,
                "outcome": r.outcome,
                "rejection_reason": r.rejection_reason,
            }
            for r in pipeline_result.stage_results
        ],
        "decisionId": f"{applicant_id}_{int(time.time())}",
        "ts": int(time.time()),
    }

    try:
        rdb.setex(ck, 3600, json.dumps(output))
    except Exception:
        pass

    return output


@app.post("/underwrite/scorecard")
@limiter.limit("100/15minutes")
async def underwrite_scorecard(request: Request, payload: dict, x_internal_secret: str = Header(None)):
    """WoE logistic regression scorecard — returns credit score 300–850 and PD estimate."""
    auth(x_internal_secret)

    import hashlib
    cache_key_data = json.dumps(payload, sort_keys=True)
    ck = f"ml:scorecard:{hashlib.md5(cache_key_data.encode()).hexdigest()}"

    try:
        cached = rdb.get(ck)
        if cached:
            return json.loads(cached)
    except Exception:
        pass

    sc = run_scorecard(payload)

    output = {
        "credit_score": sc.credit_score,
        "pd_estimate": sc.pd_estimate,
        "risk_grade": sc.risk_grade,
        "log_odds": sc.log_odds,
        "approved": sc.approved,
        "woe_contributions": sc.woe_contributions,
        "model": "woe_logistic_v1",
        "ts": int(time.time()),
    }

    try:
        rdb.setex(ck, TTL, json.dumps(output))
    except Exception:
        pass

    return output


@app.post("/underwrite/fraud")
@limiter.limit("100/15minutes")
async def underwrite_fraud(request: Request, payload: dict, x_internal_secret: str = Header(None)):
    """Isolation Forest fraud detection — real-time behavioural anomaly scoring.

    Results are NOT cached because fraud signals (velocity, geo, etc.) are time-sensitive.
    """
    auth(x_internal_secret)

    fraud = run_fraud_detection(payload)

    return {
        "fraud_score": fraud.fraud_score,
        "is_fraud": fraud.is_fraud,
        "needs_review": fraud.needs_review,
        "hard_flags": fraud.hard_flags,
        "anomaly_contributions": fraud.anomaly_contributions,
        "isolation_forest_score": fraud.isolation_forest_score,
        "model": "isolation_forest_v1",
        "ts": int(time.time()),
    }


@app.post("/score")
@limiter.limit("100/15minutes")
async def score_loan_direct(
    request: Request, payload: dict, x_internal_secret: str = Header(None)
):
    """
    Direct synchronous scoring endpoint.
    Accepts the same payload as the BullMQ job data so other services
    can call underwriting synchronously without going through the queue.
    """
    auth(x_internal_secret)
    from workers.underwriting_worker import (
        process_underwrite_loan,
        encode_pay_freq,
        encode_industry,
        get_rejection_reason,
        APPROVAL_THRESHOLD,
    )
    from models.underwriting_model import UnderwritingModel
    import os as _os

    borrower = payload.get("borrowerSnapshot", {})
    principal = float(payload.get("principalAmount", 0))
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

    model_path = _os.environ.get("MODEL_PATH", "models/underwriting_v1.joblib")
    model = UnderwritingModel.load(model_path)
    prob = model.predict_proba(features)
    decision = "approved" if prob >= APPROVAL_THRESHOLD else "rejected"

    if features["employment_tenure_months"] < 3:
        decision = "rejected"

    return {
        "decision": decision,
        "score": round(prob, 4),
        "threshold": APPROVAL_THRESHOLD,
        "model": "logistic_v1.0",
    }
