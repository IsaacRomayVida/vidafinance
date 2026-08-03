"""
Unit tests for the underwriting worker's helper functions and local model.

`workers/underwriting_worker.py` is not on the live decision path — see
docs/adr/ADR-004-underwriting-worker-not-the-decision-path.md — so these tests
cover only the pure helpers and the local scoring model, not job processing.

To run against live services, set:
  REDIS_URL, FIREBASE_SERVICE_ACCOUNT, INTEGRATION_TEST=1
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

import pytest

# Ensure the ml-service root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── Unit tests for helper functions ──────────────────────────────────────────


def test_encode_pay_freq():
    from workers.underwriting_worker import encode_pay_freq

    assert encode_pay_freq("weekly") == 4
    assert encode_pay_freq("biweekly") == 2
    assert encode_pay_freq("monthly") == 1
    assert encode_pay_freq("unknown") == 1
    assert encode_pay_freq("") == 1


def test_encode_industry():
    from workers.underwriting_worker import encode_industry

    assert encode_industry("manufacturing") == 1
    assert encode_industry("Manufacturing") == 1
    assert encode_industry("technology") == 4
    assert encode_industry("unknown") == 0
    assert encode_industry("") == 0


def test_build_model_features_emits_employer_industry_encoded():
    """
    Regression guard for #463: build_model_features computed industry_code
    via encode_industry() but dropped it from the returned dict. The feature
    is declared in models.underwriting_model.UnderwritingModel.FEATURE_ORDER
    and monitored by models.drift_monitor.FEATURE_NAMES — if this stops being
    emitted, drift monitoring on it silently defaults to a fake "stable" 0.0
    column instead of catching the regression.
    """
    from workers.underwriting_worker import build_model_features, encode_industry

    borrower = {"employerIndustry": "technology", "employmentTenureMonths": 24}
    features = build_model_features(borrower, principal=2000, monthly_salary=20000)

    assert "employer_industry_encoded" in features
    assert features["employer_industry_encoded"] == encode_industry("technology")
    assert features["employer_industry_encoded"] == 4.0


def test_get_rejection_reason_tenure():
    from workers.underwriting_worker import get_rejection_reason

    reason = get_rejection_reason(
        0.30, {"employment_tenure_months": 2, "loan_to_salary_ratio": 0.10}
    )
    assert "tenure" in reason.lower()


def test_get_rejection_reason_high_ratio():
    from workers.underwriting_worker import get_rejection_reason

    reason = get_rejection_reason(
        0.50, {"employment_tenure_months": 12, "loan_to_salary_ratio": 0.40}
    )
    assert "salary" in reason.lower()


def test_get_rejection_reason_low_score():
    from workers.underwriting_worker import get_rejection_reason

    reason = get_rejection_reason(
        0.30, {"employment_tenure_months": 12, "loan_to_salary_ratio": 0.15}
    )
    assert "credit risk" in reason.lower()


# ── Model unit tests ──────────────────────────────────────────────────────────


def test_model_loads():
    from models.underwriting_model import UnderwritingModel

    model = UnderwritingModel.load("models/underwriting_v1.joblib")
    assert model is not None
    assert len(model.weights) == 8


def test_model_predict_good_borrower():
    from models.underwriting_model import UnderwritingModel

    model = UnderwritingModel.load("models/underwriting_v1.joblib")
    features = {
        "employment_tenure_months": 24,
        "monthly_salary": 20000,
        "pay_frequency_encoded": 2,
        "loan_to_salary_ratio": 0.10,
        "employer_industry_encoded": 1,
        "principal_amount": 2000,
        "bureau_score": 700,
        "has_bureau_record": 1,
    }
    prob = model.predict_proba(features)
    assert 0.0 <= prob <= 1.0
    # Good borrower should have a high repayment probability
    assert prob >= 0.60, f"Expected high probability for good borrower, got {prob:.3f}"


def test_model_predict_risky_borrower():
    from models.underwriting_model import UnderwritingModel

    model = UnderwritingModel.load("models/underwriting_v1.joblib")
    features = {
        "employment_tenure_months": 1,
        "monthly_salary": 6000,
        "pay_frequency_encoded": 1,
        "loan_to_salary_ratio": 0.50,
        "employer_industry_encoded": 0,
        "principal_amount": 3000,
        "bureau_score": 350,
        "has_bureau_record": 0,
    }
    prob = model.predict_proba(features)
    assert 0.0 <= prob <= 1.0
    # Risky borrower should have a low repayment probability
    assert prob <= 0.50, f"Expected low probability for risky borrower, got {prob:.3f}"


# ── Live integration test (skipped unless INTEGRATION_TEST=1) ─────────────────


@pytest.mark.skipif(
    os.environ.get("INTEGRATION_TEST") != "1",
    reason="Requires live Redis + Firebase. Set INTEGRATION_TEST=1 to run.",
)
@pytest.mark.asyncio
async def test_live_job_processing():
    """
    Push a real job to Redis and verify the worker processes it.
    Requires REDIS_URL, FIREBASE_SERVICE_ACCOUNT set in environment.
    """
    from bullmq import Queue
    from redis.asyncio import Redis as AsyncRedis

    redis_url = os.environ["REDIS_URL"]
    loan_id = f"integration-test-{int(datetime.now(timezone.utc).timestamp())}"

    # Push test job to queue
    conn = AsyncRedis.from_url(redis_url)
    queue = Queue("vida-underwriting", {"connection": redis_url})
    job = await queue.add(
        "underwrite_loan",
        {
            "loanId": loan_id,
            "userId": "test-user-integration",
            "employerId": "test-employer",
            "principalAmount": 1500,
            "borrowerSnapshot": {
                "employmentTenureMonths": 12,
                "monthlySalary": 12000,
                "payFrequency": "biweekly",
                "employerIndustry": "retail",
                "curpHash": "integration-test-hash",
                "fullName": "Test User Integration",
            },
        },
    )
    print(f"Pushed job {job.id} for loan {loan_id}")

    # Wait up to 30s for the worker to process it
    from services.firestore_client import FirestoreClient

    firestore = FirestoreClient()
    deadline = asyncio.get_event_loop().time() + 30

    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2)
        loan = firestore.get_loan(loan_id)
        if loan and loan.get("status") in ("approved", "rejected"):
            print(
                f"Loan {loan_id} → {loan['status']} (score={loan.get('underwritingScore')})"
            )
            assert loan.get("underwritingStage") is not None
            await conn.aclose()
            return

    await conn.aclose()
    pytest.fail(f"Loan {loan_id} did not move from 'pending' within 30 seconds")
