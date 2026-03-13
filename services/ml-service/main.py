from fastapi import FastAPI, HTTPException, Header
import os, json, time
import redis as Redis
from dotenv import load_dotenv

load_dotenv()
from scoring import employer_score, employee_score, fraud_score

app = FastAPI(title="vida-ml-service")
rdb = Redis.from_url(
    os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True
)
SEC = os.environ.get("INTERNAL_SECRET", "")
AKEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTL = int(os.environ.get("ML_CACHE_TTL", "86400"))


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
    return {"status": "ok" if r else "degraded", "service": "vida-ml-service", "redis": r}


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
