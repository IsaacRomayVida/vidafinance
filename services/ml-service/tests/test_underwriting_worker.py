"""
Integration test for the underwriting worker.

Tests run entirely with mocked Redis + Firestore so no live credentials
are required. The full job-processing pipeline is exercised:
  job data → feature vector → model → decision → Firestore update → Redis push

To run against live services, set:
  REDIS_URL, FIREBASE_SERVICE_ACCOUNT, INTEGRATION_TEST=1
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import numpy as np

# Ensure the ml-service root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── Fixtures ──────────────────────────────────────────────────────────────────

GOOD_JOB_DATA = {
    "loanId": "test-loan-001",
    "userId": "user-abc",
    "employerId": "employer-xyz",
    "principalAmount": 1500,
    "borrowerSnapshot": {
        "employmentTenureMonths": 36,      # 3 years tenure
        "monthlySalary": 22000,            # solid salary
        "payFrequency": "biweekly",
        "employerIndustry": "manufacturing",
        "curpHash": "abc123",
        "fullName": "Juan Pérez López",
    },
}

LOW_TENURE_JOB_DATA = {
    **GOOD_JOB_DATA,
    "loanId": "test-loan-low-tenure",
    "borrowerSnapshot": {
        **GOOD_JOB_DATA["borrowerSnapshot"],
        "employmentTenureMonths": 1,  # < 3 → hard reject
    },
}

HIGH_RATIO_JOB_DATA = {
    **GOOD_JOB_DATA,
    "loanId": "test-loan-high-ratio",
    "principalAmount": 5000,
    "borrowerSnapshot": {
        **GOOD_JOB_DATA["borrowerSnapshot"],
        "monthlySalary": 6000,   # loan/salary = 0.83 → reject
    },
}


def make_job(data: dict):
    job = MagicMock()
    job.data = data
    job.id = data["loanId"]
    return job


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


def test_get_rejection_reason_tenure():
    from workers.underwriting_worker import get_rejection_reason
    reason = get_rejection_reason(0.30, {"employment_tenure_months": 2, "loan_to_salary_ratio": 0.10})
    assert "tenure" in reason.lower()


def test_get_rejection_reason_high_ratio():
    from workers.underwriting_worker import get_rejection_reason
    reason = get_rejection_reason(0.50, {"employment_tenure_months": 12, "loan_to_salary_ratio": 0.40})
    assert "salary" in reason.lower()


def test_get_rejection_reason_low_score():
    from workers.underwriting_worker import get_rejection_reason
    reason = get_rejection_reason(0.30, {"employment_tenure_months": 12, "loan_to_salary_ratio": 0.15})
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


# ── Worker integration tests (fully mocked) ───────────────────────────────────

@pytest.mark.asyncio
async def test_good_loan_approved():
    """A borrower with 18 months tenure, 15k salary, 2k loan should be approved."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={"_type": "arrayUnion", "values": [{}]})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch("workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        result = await process_underwrite_loan(make_job(GOOD_JOB_DATA))

    assert result["decision"] == "approved"
    assert 0.0 <= result["score"] <= 1.0
    assert result["score"] >= 0.65

    # Firestore should be updated
    firestore_mock.update_loan.assert_called_once()
    update_args = firestore_mock.update_loan.call_args[0]
    assert update_args[0] == "test-loan-001"
    assert update_args[1]["status"] == "approved"
    assert update_args[1]["underwritingModel"] == "logistic_v1.0"

    # Disbursement job should be pushed
    assert redis_mock.lpush.call_count >= 2  # disbursements + notifications
    calls = [call[0][0] for call in redis_mock.lpush.call_args_list]
    assert "jobs:disbursements" in calls
    assert "jobs:notifications" in calls


@pytest.mark.asyncio
async def test_low_tenure_hard_reject():
    """Borrower with only 1 month tenure must be rejected regardless of model score."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch("workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        result = await process_underwrite_loan(make_job(LOW_TENURE_JOB_DATA))

    assert result["decision"] == "rejected"
    update_args = firestore_mock.update_loan.call_args[0]
    assert update_args[1]["status"] == "rejected"
    assert "tenure" in (update_args[1].get("rejectionReason") or "").lower()

    # Notification pushed but NOT disbursement
    calls = [call[0][0] for call in redis_mock.lpush.call_args_list]
    assert "jobs:notifications" in calls
    assert "jobs:disbursements" not in calls


@pytest.mark.asyncio
async def test_bureau_enrichment_failure_gracefully_degrades():
    """If softcredito bureau call fails, job should still complete with defaults."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    softcredito_mock = AsyncMock()
    softcredito_mock.query_bureau = AsyncMock(side_effect=Exception("Connection refused"))

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch("workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock),
        patch("workers.underwriting_worker.SoftcreditoClient", return_value=softcredito_mock),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        result = await process_underwrite_loan(make_job(GOOD_JOB_DATA))

    # Job should still complete — bureau failure is non-fatal
    assert result["decision"] in ("approved", "rejected")
    firestore_mock.update_loan.assert_called_once()


@pytest.mark.asyncio
async def test_notification_always_pushed():
    """Notifications should be pushed for both approved and rejected loans."""
    from workers.underwriting_worker import process_underwrite_loan

    for job_data in [GOOD_JOB_DATA, LOW_TENURE_JOB_DATA]:
        firestore_mock = MagicMock()
        firestore_mock.update_loan = MagicMock(return_value=None)
        firestore_mock.array_union = MagicMock(return_value={})

        redis_mock = AsyncMock()
        redis_mock.lpush = AsyncMock(return_value=1)
        redis_mock.aclose = AsyncMock()

        with (
            patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
            patch("workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock),
            patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
        ):
            await process_underwrite_loan(make_job(job_data))

        notification_calls = [
            call for call in redis_mock.lpush.call_args_list
            if call[0][0] == "jobs:notifications"
        ]
        assert len(notification_calls) == 1, (
            f"Expected 1 notification push for {job_data['loanId']}"
        )
        notification_payload = json.loads(notification_calls[0][0][1])
        assert notification_payload["loanId"] == job_data["loanId"]
        assert notification_payload["type"] in ("loan_approved", "loan_rejected")


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
            print(f"Loan {loan_id} → {loan['status']} (score={loan.get('underwritingScore')})")
            assert loan.get("underwritingModel") == "logistic_v1.0"
            await conn.aclose()
            return

    await conn.aclose()
    pytest.fail(f"Loan {loan_id} did not move from 'pending' within 30 seconds")
