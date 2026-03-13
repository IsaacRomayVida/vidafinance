def employer_score(p):
    sz = {"1-10": 5, "11-50": 30, "51-200": 125, "201-500": 350, "500+": 750}.get(
        p.get("companySize", "1-10"), 5
    )
    s = 50
    if sz >= 50:
        s += 15
    if p.get("yearsActive", 0) >= 3:
        s += 10
    if p.get("payrollSystem", "") in ["SAP", "Aspel NOI", "Oracle HCM"]:
        s += 10
    if p.get("satStatus", "") == "active":
        s += 10
    if sz < 5:
        s -= 20
    if p.get("yearsActive", 0) < 1:
        s -= 25
    s = max(0, min(100, s))
    tier = 1 if s >= 70 else (2 if s >= 40 else 3)
    return {"score": s, "risk_tier": tier, "reject": tier == 3, "model": "rule_based"}


def employee_score(p):
    sal = p.get("monthlySalary", 0)
    tier = p.get("employerTier", 2)
    s = 50
    if sal >= 20000:
        s += 15
    elif sal >= 12000:
        s += 8
    if tier == 1:
        s += 15
    elif tier == 2:
        s += 5
    if p.get("existingLoans", 0) > 0:
        s -= 30
    if p.get("bankClabe"):
        s += 10
    s = max(0, min(100, s))
    limit = min(5000, round(sal * 0.30 / 100) * 100)
    return {
        "credit_score": s,
        "recommended_limit": limit,
        "default_probability": round(max(0.01, (100 - s) / 200), 3),
        "model": "rule_based",
    }


def fraud_score(p):
    sc = 0
    if p.get("requestsLastHour", 0) > 2:
        sc += 50
    if p.get("amountToSalaryRatio", 0) > 0.35:
        sc += 20
    return {"anomaly_score": min(100, sc), "is_fraud": sc >= 50}
