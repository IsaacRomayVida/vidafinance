import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Header, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from prometheus_client import Counter, Histogram, make_asgi_app
import os, json, time
import redis as Redis
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

load_dotenv()
from scoring import employer_score, employee_score, fraud_score
from services.firestore_client import FirestoreClient
from monitoring.alerts import alert_5xx, alert_redis_lost, alert_model_fallback, alert_rate_limit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-service")

rdb = Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True
)
SEC = os.environ.get("INTERNAL_SECRET", "")
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTL = int(os.environ.get("ML_CACHE_TTL", "86400"))

# Prefix check avoids 401-per-request when a placeholder string is set.
_LLM_ENABLED = AKEY.startswith("sk-ant-")
if AKEY and not _LLM_ENABLED:
    logger.warning(
        "ANTHROPIC_API_KEY is set but does not look like a real key; "
        "LLM enrichment disabled."
    )
elif not AKEY:
    logger.info("ANTHROPIC_API_KEY not set; LLM enrichment disabled.")

VERSION = "1.0.0"
START_TIME = time.time()

predictions_total = Counter(
    "ml_predictions_total",
    "Total ML predictions served",
    ["endpoint", "outcome"],
)
prediction_latency_seconds = Histogram(
    "ml_prediction_latency_seconds",
    "Prediction latency",
    ["endpoint"],
)
fallback_total = Counter(
    "ml_fallback_total",
    "Times ml-service fell back to default/neutral response",
    ["endpoint", "reason"],
)

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

    # Start Redis connection monitor
    _redis_monitor_task = asyncio.create_task(_check_redis_connection())

    yield

    _redis_monitor_task.cancel()
    try:
        await _redis_monitor_task
    except asyncio.CancelledError:
        pass

    for task, name in [(_worker_task, "worker"), (_drift_task, "drift scheduler")]:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.info("%s stopped", name)


app = FastAPI(title="vida-ml-service", lifespan=lifespan)


# ── 5xx alert middleware ───────────────────────────────────────────────
class AlertMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if response.status_code >= 500:
            await alert_5xx(response.status_code, request.url.path)
        return response

app.add_middleware(AlertMiddleware)

app.mount("/metrics", make_asgi_app())


# ── Redis connection monitoring ────────────────────────────────────────
_redis_was_connected = True

async def _check_redis_connection():
    global _redis_was_connected
    while True:
        try:
            rdb.ping()
            _redis_was_connected = True
        except Exception:
            if _redis_was_connected:
                _redis_was_connected = False
                await alert_redis_lost()
        await asyncio.sleep(30)


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


_RISK_TIER_OUTCOME = {1: "approve", 2: "review", 3: "decline"}


@app.post("/underwrite/employer")
async def score_emp(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    endpoint = "/underwrite/employer"
    _start = time.time()
    outcome = "error"
    try:
        uid = payload.get("employerUid", "")
        ck = f"ml:employer:{uid}"
        try:
            c = rdb.get(ck)
            if c:
                cached = json.loads(c)
                outcome = _RISK_TIER_OUTCOME.get(cached.get("risk_tier"), "success")
                return cached
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
        global _LLM_ENABLED
        if _LLM_ENABLED:
            import anthropic

            try:
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
            except anthropic.AuthenticationError as e:
                # Disable for the process so a bad key doesn't spam logs per request.
                _LLM_ENABLED = False
                fallback_total.labels(endpoint=endpoint, reason="anthropic_auth_failed").inc()
                logger.warning(
                    "Anthropic authentication failed; disabling LLM enrichment for this process: %s",
                    e,
                )
            except Exception as e:
                fallback_total.labels(endpoint=endpoint, reason="anthropic_unavailable").inc()
                logger.warning("LLM enrichment failed, falling back to rule-based: %s", e)
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
        outcome = _RISK_TIER_OUTCOME.get(final.get("risk_tier"), "success")
        return final
    finally:
        prediction_latency_seconds.labels(endpoint=endpoint).observe(time.time() - _start)
        predictions_total.labels(endpoint=endpoint, outcome=outcome).inc()


@app.post("/underwrite/employee")
async def score_employee(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    endpoint = "/underwrite/employee"
    _start = time.time()
    outcome = "error"
    try:
        uid = payload.get("employeeId", "")
        amt = payload.get("amount", 0)
        ck = f"ml:employee:{uid}:{amt}"
        try:
            c = rdb.get(ck)
            if c:
                outcome = "success"
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
        outcome = "success"
        return final
    finally:
        prediction_latency_seconds.labels(endpoint=endpoint).observe(time.time() - _start)
        predictions_total.labels(endpoint=endpoint, outcome=outcome).inc()


@app.get("/explain/{decision_id}")
def explain(decision_id: str, x_internal_secret: str = Header(None)):
    """
    Retrieve SHAP explanations for a decision.

    Looks up the loan's stored SHAP top-5 from Firestore. If the loan
    has challenger SHAP values stored, returns them directly.
    """
    auth(x_internal_secret)
    try:
        firestore = FirestoreClient()
        loan = firestore.get_loan(decision_id)
        if loan and loan.get("shapTop5"):
            return {
                "decisionId": decision_id,
                "championModel": loan.get("underwritingModel", "unknown"),
                "challengerModel": loan.get("challengerModel", "unknown"),
                "championScore": loan.get("underwritingScore"),
                "challengerScore": loan.get("challengerScore"),
                "shapTop5": loan.get("shapTop5", []),
            }
    except Exception:
        pass

    return {
        "decisionId": decision_id,
        "shapTop5": [],
        "message": "No SHAP data found for this decision",
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


_DECISION_OUTCOME = {"approved": "approve", "rejected": "decline"}


@app.post("/score")
async def score_loan_direct(
    payload: dict, x_internal_secret: str = Header(None)
):
    """
    Direct synchronous scoring endpoint.
    Runs both champion (WoE scorecard) and challenger (XGBoost) models.
    Returns champion decision + challenger shadow score + SHAP top-5.
    """
    auth(x_internal_secret)
    endpoint = "/score"
    _start = time.time()
    outcome = "error"
    try:
        from workers.underwriting_worker import (
            build_model_features,
            APPROVAL_THRESHOLD,
        )
        from models.champion_challenger import ModelRouter
        import os as _os

        borrower = payload.get("borrowerSnapshot", {})
        principal = float(payload.get("principalAmount", 0))
        monthly_salary = float(borrower.get("monthlySalary", 1))

        features = build_model_features(borrower, principal, monthly_salary)

        champion_path = _os.environ.get("CHAMPION_MODEL_PATH", "models/scorecard_champion_v2.joblib")
        challenger_path = _os.environ.get("CHALLENGER_MODEL_PATH", "models/xgb_challenger_v2.joblib")
        try:
            router = ModelRouter.load(champion_path, challenger_path)
        except Exception:
            fallback_total.labels(endpoint=endpoint, reason="model_load_failed").inc()
            raise
        result = router.predict(features, threshold=APPROVAL_THRESHOLD)

        decision = result["decision"]
        if features["employment_tenure_months"] < 3:
            decision = "rejected"

        # VID3-712 — ML_MODE override
        from ml_mode import apply_ml_mode_override
        decision = apply_ml_mode_override(decision)

        outcome = _DECISION_OUTCOME.get(decision, "review")
        return {
            "decision": decision,
            "championScore": result["champion_score"],
            "challengerScore": result["challenger_score"],
            "threshold": APPROVAL_THRESHOLD,
            "championModel": result["champion_model"],
            "challengerModel": result["challenger_model"],
            "shapTop5": result["shap_top5"],
        }
    finally:
        prediction_latency_seconds.labels(endpoint=endpoint).observe(time.time() - _start)
        predictions_total.labels(endpoint=endpoint, outcome=outcome).inc()


