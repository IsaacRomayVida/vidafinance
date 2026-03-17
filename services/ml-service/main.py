from fastapi import FastAPI, HTTPException, Header
import os, json, time
from dataclasses import asdict
import redis as Redis
from dotenv import load_dotenv

load_dotenv()
from scoring import employer_score, employee_score, fraud_score
from decision_tree import run_pipeline, PipelineResult
from woe_scorecard import score as woe_score
from fraud_detector import detect as fraud_detect

app = FastAPI(title="vida-ml-service", version="1.0.0")
rdb = Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True
)
SEC = os.environ.get("INTERNAL_SECRET", "")
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTL = int(os.environ.get("ML_CACHE_TTL", "86400"))


def auth(s):
    if s != SEC:
        raise HTTPException(401, "Unauthorized")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    try:
        rdb.ping()
        r = True
    except Exception:
        r = False
    return {
        "status": "ok" if r else "degraded",
        "service": "vida-ml-service",
        "version": "1.0.0",
        "redis": r,
        "engine": "decision_tree_v1",
    }


# ---------------------------------------------------------------------------
# Full underwriting pipeline (Decision Tree Stages 0-5)
# ---------------------------------------------------------------------------

@app.post("/underwrite/pipeline")
async def pipeline(payload: dict, x_internal_secret: str = Header(None)):
    """Run the full ML underwriting pipeline.

    Executes Decision Tree stages 0-5 with WoE logistic regression
    scorecard, Isolation Forest fraud detection, and LLM-as-Judge
    for Stage 5 escalations.

    Required payload keys:
      - monthly_salary_mxn: float
      - bureau_score: int (from SoftCrédito)
      - employer_tier: int (1-3)

    Optional keys consumed by stages:
      - application_id, applicant_name, curp, rfc
      - dias_atraso, cartera_vencida, cuentas_activas
      - device_risk_score, infonavit_monthly_deduction
      - is_government_employer, issste_active, issste_salary_sbc
      - imss_active, imss_salary_sbc, afore_balance_mxn, tenure_months
      - kyc_verified, pld_bloqueo_lista_sat
      - requests_last_hour, amount_to_salary_ratio, behavioral_risk_score
      - sardine_pass, sardine_risk_level
      - bank_avg_balance_90d, bank_overdraft_count_90d
      - aml_criminal_records, aml_pep_match, aml_sanctions_match
      - requested_amount_mxn, existing_loans, employer_name
    """
    auth(x_internal_secret)
    app_id = payload.get("application_id", "")
    ck = f"ml:pipeline:{app_id}" if app_id else None

    # Check cache
    if ck:
        try:
            c = rdb.get(ck)
            if c:
                return json.loads(c)
        except Exception:
            pass

    result = run_pipeline(payload)
    result_dict = asdict(result)

    # Cache result
    if ck:
        try:
            rdb.setex(ck, TTL, json.dumps(result_dict))
        except Exception:
            pass

    return result_dict


# ---------------------------------------------------------------------------
# Standalone WoE scorecard
# ---------------------------------------------------------------------------

@app.post("/underwrite/scorecard")
async def scorecard(payload: dict, x_internal_secret: str = Header(None)):
    """Run standalone WoE logistic regression scorecard."""
    auth(x_internal_secret)
    result = woe_score(payload)
    return asdict(result)


# ---------------------------------------------------------------------------
# Standalone fraud detection
# ---------------------------------------------------------------------------

@app.post("/underwrite/fraud")
async def fraud(payload: dict, x_internal_secret: str = Header(None)):
    """Run standalone Isolation Forest fraud detection."""
    auth(x_internal_secret)
    result = fraud_detect(payload)
    return asdict(result)


# ---------------------------------------------------------------------------
# Legacy endpoints (preserved for backward compatibility)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Explainability & monitoring
# ---------------------------------------------------------------------------

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


@app.delete("/cache/pipeline/{app_id}")
def clear_pipeline_cache(app_id: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    try:
        rdb.delete(f"ml:pipeline:{app_id}")
    except Exception:
        pass
    return {"cleared": f"ml:pipeline:{app_id}"}
