import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Header
import os, json, time
import redis as Redis
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

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

VERSION = "1.0.0"
START_TIME = time.time()

# Initialize Firebase if credentials are available
_fb_app = None
_fs_db = None
_fb_raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64") or os.environ.get("FIREBASE_SERVICE_ACCOUNT")
if _fb_raw:
    try:
        import base64
        sa = json.loads(base64.b64decode(_fb_raw) if os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64") else _fb_raw)
        cred = credentials.Certificate(sa)
        _fb_app = firebase_admin.initialize_app(cred)
        _fs_db = firestore.client()
    except Exception as e:
        logger.warning("Firebase init failed: %s", e)

_worker_task: asyncio.Task | None = None
_drift_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker_task, _drift_task
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

    # Start drift monitoring scheduler
    if _fs_db:
        try:
            from monitoring.scheduler import drift_scheduler
            from monitoring.alerts import send_drift_alert
            _drift_task = asyncio.create_task(drift_scheduler(_fs_db, send_drift_alert))
            logger.info("Drift monitoring scheduler started")
        except Exception as e:
            logger.warning("Could not start drift scheduler: %s", e)

    yield

    for task, name in [(_worker_task, "worker"), (_drift_task, "drift scheduler")]:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.info("%s stopped", name)


app = FastAPI(title="vida-ml-service", lifespan=lifespan)


def auth(s):
    if s != SEC:
        raise HTTPException(401, "Unauthorized")


@app.get("/health")
def health():
    try:
        rdb.ping()
        redis_ok = True
    except Exception:
        redis_ok = False

    firestore_ok = False
    if _fs_db:
        try:
            list(_fs_db.collection("_health").limit(1).stream())
            firestore_ok = True
        except Exception:
            pass

    # Queue depth for underwriting queue
    queue_depth = {}
    try:
        queue_depth["underwriting"] = rdb.llen("bull:vida-underwriting:wait")
    except Exception:
        queue_depth["underwriting"] = -1

    worker_alive = _worker_task is not None and not _worker_task.done()
    down = not redis_ok and not firestore_ok
    degraded = not redis_ok or not firestore_ok or not worker_alive
    return {
        "status": "down" if down else ("degraded" if degraded else "ok"),
        "service": "vida-ml-service",
        "version": VERSION,
        "uptime_seconds": int(time.time() - START_TIME),
        "redis": redis_ok,
        "firestore": firestore_ok,
        "worker": "running" if worker_alive else "stopped",
        "queue_depth": queue_depth,
        "ts": datetime.now(timezone.utc).isoformat(),
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
async def drift(payload: dict = None, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    if not _fs_db:
        return {"error": "Firestore not configured", "drift_detected": False}
    from monitoring.drift import run_weekly_drift_job
    from monitoring.alerts import send_drift_alert
    result = await run_weekly_drift_job(_fs_db, send_drift_alert)
    return {
        "drift_detected": bool(result.get("alerts")),
        "psi_scores": result.get("psi", {}),
        "csi_scores": result.get("csi", {}),
        "alerts": result.get("alerts", []),
        "evidently_drift": result.get("evidently_drift", {}),
    }


@app.get("/monitor/drift/latest")
def drift_latest(x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    if not _fs_db:
        return {"error": "Firestore not configured"}
    try:
        docs = list(
            _fs_db.collection("ml_drift_reports")
            .order_by("createdAt", direction=firestore.Query.DESCENDING)
            .limit(1)
            .stream()
        )
        if docs:
            return docs[0].to_dict()
        return {"message": "No drift reports yet"}
    except Exception as e:
        return {"error": str(e)}


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
