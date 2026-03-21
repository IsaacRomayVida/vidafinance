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
from prompts.loader import (
    get_system_prompt,
    get_model_config,
    preload_all,
    render_user_prompt,
)

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
    loaded = preload_all()
    logger.info("Preloaded %d prompt templates: %s", len(loaded), loaded)
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


STAGE5_PROMPT = "stage5_risk_narrative_v1.7.0"


@app.post("/stage5/risk-narrative")
async def stage5_risk_narrative(payload: dict, x_internal_secret: str = Header(None)):
    """
    Generate a Stage 5 risk narrative by synthesizing MetaMap, bureau,
    ML model, and anomaly signals via Claude.

    Expects payload with: loanId, applicantName, curpHash, employerName,
    employerTier, monthlySalary, employmentTenureMonths, principalAmount,
    loanToSalaryRatio, metamapIdentity, metamapCriminal, metamapDevice,
    bureauData, riskseal, repaymentProbability, modelVersion,
    approvalThreshold, shapExplanations, anomalyFlags, escalationReason.
    """
    auth(x_internal_secret)

    if not AKEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")

    # Render user prompt from template
    user_prompt = render_user_prompt(
        STAGE5_PROMPT,
        loan_id=payload.get("loanId", "unknown"),
        applicant_name=payload.get("applicantName", "N/A"),
        curp_hash=payload.get("curpHash", "N/A"),
        employer_name=payload.get("employerName", "N/A"),
        employer_tier=payload.get("employerTier", "N/A"),
        monthly_salary=f"{float(payload.get('monthlySalary', 0)):,.2f}",
        employment_tenure_months=payload.get("employmentTenureMonths", "N/A"),
        principal_amount=f"{float(payload.get('principalAmount', 0)):,.2f}",
        loan_to_salary_ratio=f"{float(payload.get('loanToSalaryRatio', 0)):.1%}",
        metamap_identity_json=json.dumps(payload.get("metamapIdentity", {}), indent=2),
        metamap_criminal_json=json.dumps(payload.get("metamapCriminal", {}), indent=2),
        metamap_device_json=json.dumps(payload.get("metamapDevice", {}), indent=2),
        bureau_data_json=json.dumps(payload.get("bureauData", {}), indent=2),
        riskseal_json=json.dumps(payload.get("riskseal", {}), indent=2),
        repayment_probability=f"{float(payload.get('repaymentProbability', 0)):.4f}",
        model_version=payload.get("modelVersion", "logistic_v1.0"),
        approval_threshold=payload.get("approvalThreshold", APPROVAL_THRESHOLD),
        shap_explanations_json=json.dumps(payload.get("shapExplanations", []), indent=2),
        anomaly_flags_json=json.dumps(payload.get("anomalyFlags", {}), indent=2),
        escalation_reason=payload.get("escalationReason", "Not specified"),
    )

    system_prompt = get_system_prompt(STAGE5_PROMPT)
    config = get_model_config(STAGE5_PROMPT)

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=AKEY)
        msg = client.messages.create(
            model=config["model"],
            max_tokens=config["max_tokens"],
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        narrative = json.loads(msg.content[0].text)
    except json.JSONDecodeError as e:
        logger.error("Claude returned invalid JSON for loan %s: %s", payload.get("loanId"), e)
        raise HTTPException(502, "LLM returned invalid JSON")
    except Exception as e:
        logger.error("LLM error for Stage 5 narrative (loan %s): %s", payload.get("loanId"), e)
        raise HTTPException(502, f"LLM error: {e}")

    return {
        "loanId": payload.get("loanId"),
        "promptVersion": "v1.7.0",
        "narrative": narrative,
        "ts": int(time.time()),
    }
