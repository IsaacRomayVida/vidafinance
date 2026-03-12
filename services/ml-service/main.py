from fastapi import FastAPI, HTTPException, Header
import os; from dotenv import load_dotenv; load_dotenv()
import redis as Redis, json, time

app = FastAPI(title='vida-ml-service')
rdb = Redis.from_url(os.environ.get('REDIS_URL','redis://localhost:6379'), decode_responses=True)
INTERNAL_SECRET = os.environ.get('INTERNAL_SECRET','')

def auth(secret): 
    if secret != INTERNAL_SECRET: raise HTTPException(401,'Unauthorized')

@app.get('/health')
def health():
    try: rdb.ping(); r=True
    except: r=False
    return {'status':'ok' if r else 'degraded','service':'vida-ml-service','redis':r}

@app.post('/underwrite/employer')
async def score_employer(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    uid = payload.get('employerUid','')
    ck = f'ml:employer:{uid}'
    cached = rdb.get(ck)
    if cached: return json.loads(cached)
    s = 50
    sz = {'1-10':5,'11-50':30,'51-200':125,'201-500':350,'500+':750}.get(payload.get('companySize','1-10'),5)
    if sz >= 50: s += 15
    if payload.get('yearsActive',0) >= 3: s += 10
    if payload.get('payrollSystem') in ['SAP','Aspel NOI','Oracle HCM']: s += 10
    if payload.get('satStatus') == 'active': s += 10
    if sz < 5: s -= 20
    if payload.get('yearsActive',0) < 1: s -= 25
    s = max(0, min(100, s))
    tier = 1 if s >= 70 else (2 if s >= 40 else 3)
    llm = {'risk_tier':tier,'red_flags':[],'green_flags':[],'escalate_to_human':False}
    ak = os.environ.get('ANTHROPIC_API_KEY','')
    if ak:
        try:
            import anthropic; client = anthropic.Anthropic(api_key=ak)
            msg = client.messages.create(model='claude-sonnet-4-20250514',max_tokens=400,
                system='Credit risk analyst for VIDA Finance Mexico. Respond ONLY with valid JSON.',
                messages=[{'role':'user','content':f'Analyze employer risk: Company={payload.get("companyName","?")} Size={payload.get("companySize","?")} Industry={payload.get("industry","?")} Payroll={payload.get("payrollSystem","?")} Years={payload.get("yearsActive","?")}. JSON: {{"risk_tier":1|2|3,"red_flags":[],"green_flags":[],"escalate_to_human":true|false,"summary":"one sentence"}}'}])
            llm = json.loads(msg.content[0].text)
        except Exception as e: print('LLM error:',e)
    result = {'score':s,'risk_tier':tier,'reject':tier==3,'llm_analysis':llm,'fraud':{'anomaly_score':0,'is_fraud':False},'shap':[],'decisionId':f'{uid}_{int(time.time())}','model':'rule_based'}
    rdb.setex(ck, int(os.environ.get('ML_CACHE_TTL','86400')), json.dumps(result))
    return result

@app.post('/underwrite/employee')
async def score_employee(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    uid, amount = payload.get('employeeId',''), payload.get('amount',0)
    ck = f'ml:employee:{uid}:{amount}'
    cached = rdb.get(ck)
    if cached: return json.loads(cached)
    sal = payload.get('monthlySalary',0)
    tier = payload.get('employerTier',2)
    s = 50
    if sal >= 20000: s += 15
    elif sal >= 12000: s += 8
    if tier == 1: s += 15
    elif tier == 2: s += 5
    if payload.get('existingLoans',0) > 0: s -= 30
    if payload.get('bankClabe'): s += 10
    rph = payload.get('requestsLastHour',0)
    fraud_s = min(100, rph * 25 + (30 if amount/max(sal,1) > 0.35 else 0))
    s = max(0, min(100, s))
    result = {'credit_score':s,'recommended_limit':min(5000,round(sal*0.30/100)*100),'default_probability':round(max(0.01,(100-s)/200),3),'fraud':{'anomaly_score':fraud_s,'is_fraud':fraud_s>=50},'shap':[],'decisionId':f'{uid}_{int(time.time())}','model':'rule_based'}
    rdb.setex(ck, 3600, json.dumps(result))
    return result

@app.get('/explain/{decision_id}')
def explain(decision_id: str, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {'decisionId':decision_id,'shap':[],'message':'Full SHAP after model training'}

@app.post('/monitor/drift')
def drift(payload: dict, x_internal_secret: str = Header(None)):
    auth(x_internal_secret)
    return {'drift_detected':False,'psi_scores':{},'message':'Active after 200 loans'}
