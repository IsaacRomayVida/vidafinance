"""
Tests for the champion/challenger model deployment.

Tests cover:
  - WoE scorecard champion model (loading, prediction, WoE transform)
  - XGBoost challenger model (loading, prediction, SHAP generation)
  - Champion/challenger router (routing, shadow logging, Gini alert)
  - Updated underwriting worker integration (mocked Firestore/Redis)
"""

import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch
from types import ModuleType

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Mock modules that require Python 3.10+ (use dict|str syntax)
_bullmq_mock = ModuleType("bullmq")
_bullmq_mock.Worker = MagicMock()
_bullmq_mock.Queue = MagicMock()
sys.modules.setdefault("bullmq", _bullmq_mock)

# Mock Firestore/SoftCredito services (use dict|None syntax + need Firebase creds)
_firestore_mock_module = ModuleType("services.firestore_client")
_firestore_mock_module.FirestoreClient = MagicMock
sys.modules.setdefault("services.firestore_client", _firestore_mock_module)

_softcredito_mock_module = ModuleType("services.softcredito_client")
_softcredito_mock_module.SoftcreditoClient = MagicMock
sys.modules.setdefault("services.softcredito_client", _softcredito_mock_module)

# Ensure services package exists
if "services" not in sys.modules:
    _services_mock = ModuleType("services")
    sys.modules["services"] = _services_mock


# ── Scorecard Champion Tests ─────────────────────────────────────────────────


class TestScorecardChampion:
    def test_model_loads(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        assert model is not None
        assert model.version == "scorecard_champion_v2.0"
        assert len(model.selected_features) >= 1

    def test_iv_values_above_threshold(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        for feat in model.selected_features:
            iv = model.iv_values[feat]
            assert iv >= 0.1, f"Feature {feat} IV={iv:.4f} < 0.1 threshold"

    def test_predict_returns_probability(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        features = {
            "scDiasAtraso": 0,
            "cdcScore": 700,
            "carteraVencida": 0,
            "imss_tenure_months": 36,
            "lti": 0.10,
            "riskSeal_score": 70,
            "employer_tier": 2,
            "sector_risk": 2,
            "afore_regularity": 0.9,
            "monthly_salary": 25000,
        }
        prob = model.predict_proba(features)
        assert 0.0 <= prob <= 1.0

    def test_good_borrower_high_score(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        good_features = {
            "scDiasAtraso": 0,
            "cdcScore": 750,
            "carteraVencida": 0,
            "imss_tenure_months": 48,
            "lti": 0.08,
            "riskSeal_score": 80,
            "employer_tier": 1,
            "sector_risk": 1,
            "afore_regularity": 0.95,
            "monthly_salary": 30000,
        }
        prob = model.predict_proba(good_features)
        assert prob >= 0.60, f"Good borrower should score high, got {prob:.3f}"

    def test_risky_borrower_low_score(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        risky_features = {
            "scDiasAtraso": 120,
            "cdcScore": 350,
            "carteraVencida": 50000,
            "imss_tenure_months": 2,
            "lti": 0.60,
            "riskSeal_score": 15,
            "employer_tier": 5,
            "sector_risk": 5,
            "afore_regularity": 0.2,
            "monthly_salary": 7000,
        }
        prob = model.predict_proba(risky_features)
        assert prob <= 0.50, f"Risky borrower should score low, got {prob:.3f}"

    def test_woe_bins_exist(self):
        from models.scorecard_model import ScorecardChampion

        model = ScorecardChampion.load("models/scorecard_champion_v2.joblib")
        for feat in model.selected_features:
            assert feat in model.woe_bins
            bins = model.woe_bins[feat]
            assert len(bins) >= 2, f"Feature {feat} should have at least 2 WoE bins"
            for b in bins:
                assert "range" in b
                assert "woe" in b


# ── XGBoost Challenger Tests ─────────────────────────────────────────────────


class TestXGBChallenger:
    def test_model_loads(self):
        from models.xgb_model import XGBChallenger

        model = XGBChallenger.load("models/xgb_challenger_v2.joblib")
        assert model is not None
        assert model.version == "xgb_challenger_v2.0"
        assert len(model.feature_names) == 14

    def test_predict_returns_probability(self):
        from models.xgb_model import XGBChallenger

        model = XGBChallenger.load("models/xgb_challenger_v2.joblib")
        features = {f: 50.0 for f in model.FEATURE_SET}
        features["monthly_salary"] = 20000
        features["imss_tenure_months"] = 24
        prob = model.predict_proba(features)
        assert 0.0 <= prob <= 1.0

    def test_shap_returns_top5(self):
        from models.xgb_model import XGBChallenger

        model = XGBChallenger.load("models/xgb_challenger_v2.joblib")
        features = {f: 50.0 for f in model.FEATURE_SET}
        features["monthly_salary"] = 20000
        features["imss_tenure_months"] = 24
        shap_top5 = model.explain(features, top_n=5)
        assert len(shap_top5) == 5
        for entry in shap_top5:
            assert "feature" in entry
            assert "shap_value" in entry
            assert isinstance(entry["shap_value"], float)
            assert entry["feature"] in model.FEATURE_SET

    def test_shap_sorted_by_abs_value(self):
        from models.xgb_model import XGBChallenger

        model = XGBChallenger.load("models/xgb_challenger_v2.joblib")
        features = {f: 50.0 for f in model.FEATURE_SET}
        features["monthly_salary"] = 20000
        shap_top5 = model.explain(features, top_n=5)
        abs_vals = [abs(e["shap_value"]) for e in shap_top5]
        assert abs_vals == sorted(abs_vals, reverse=True)

    def test_good_borrower_high_score(self):
        from models.xgb_model import XGBChallenger

        model = XGBChallenger.load("models/xgb_challenger_v2.joblib")
        features = {
            "scDiasAtraso": 0,
            "cdcScore": 750,
            "carteraVencida": 0,
            "imss_tenure_months": 48,
            "lti": 0.08,
            "riskSeal_score": 80,
            "employer_tier": 1,
            "sector_risk": 1,
            "afore_regularity": 0.95,
            "monthly_salary": 30000,
            "scCuentasActivas": 2,
            "belvo_cash_flow_avg": 35000,
            "employer_score": 85,
            "payroll_regularity": 0.95,
        }
        prob = model.predict_proba(features)
        assert prob >= 0.60, f"Good borrower should score high, got {prob:.3f}"


# ── Champion/Challenger Router Tests ─────────────────────────────────────────


class TestModelRouter:
    def _get_router(self):
        from models.champion_challenger import ModelRouter

        return ModelRouter.load(
            "models/scorecard_champion_v2.joblib",
            "models/xgb_challenger_v2.joblib",
        )

    def test_router_loads(self):
        router = self._get_router()
        assert router.champion.version == "scorecard_champion_v2.0"
        assert router.challenger.version == "xgb_challenger_v2.0"

    def test_predict_returns_both_scores(self):
        router = self._get_router()
        features = {
            "scDiasAtraso": 0,
            "cdcScore": 700,
            "carteraVencida": 0,
            "imss_tenure_months": 36,
            "lti": 0.10,
            "riskSeal_score": 70,
            "employer_tier": 2,
            "sector_risk": 2,
            "afore_regularity": 0.9,
            "monthly_salary": 25000,
            "scCuentasActivas": 3,
            "belvo_cash_flow_avg": 20000,
            "employer_score": 70,
            "payroll_regularity": 0.85,
        }
        result = router.predict(features)
        assert "decision" in result
        assert "champion_score" in result
        assert "challenger_score" in result
        assert "champion_model" in result
        assert "challenger_model" in result
        assert "shap_top5" in result
        assert result["decision"] in ("approved", "rejected")
        assert 0.0 <= result["champion_score"] <= 1.0
        assert 0.0 <= result["challenger_score"] <= 1.0

    def test_champion_decides(self):
        """The champion's score determines the decision, not the challenger's."""
        router = self._get_router()
        features = {
            "scDiasAtraso": 0,
            "cdcScore": 700,
            "carteraVencida": 0,
            "imss_tenure_months": 36,
            "lti": 0.10,
            "riskSeal_score": 70,
            "employer_tier": 2,
            "sector_risk": 2,
            "afore_regularity": 0.9,
            "monthly_salary": 25000,
            "scCuentasActivas": 3,
            "belvo_cash_flow_avg": 20000,
            "employer_score": 70,
            "payroll_regularity": 0.85,
        }
        result = router.predict(features, threshold=0.65)
        expected_decision = (
            "approved" if result["champion_score"] >= 0.65 else "rejected"
        )
        assert result["decision"] == expected_decision

    def test_shap_included_in_result(self):
        router = self._get_router()
        features = {f: 50.0 for f in router.challenger.FEATURE_SET}
        features["monthly_salary"] = 20000
        result = router.predict(features)
        assert isinstance(result["shap_top5"], list)
        assert len(result["shap_top5"]) <= 5

    def test_history_recorded(self):
        router = self._get_router()
        features = {f: 50.0 for f in router.challenger.FEATURE_SET}
        features["monthly_salary"] = 20000
        initial_len = len(router.history)
        router.predict(features)
        assert len(router.history) == initial_len + 1

    def test_gini_coefficient(self):
        from models.champion_challenger import ModelRouter

        # Perfect ranking: scores match actuals
        actuals = np.array([1, 1, 1, 0, 0, 0])
        predictions = np.array([0.9, 0.8, 0.7, 0.3, 0.2, 0.1])
        gini = ModelRouter._gini_coefficient(actuals, predictions)
        assert gini >= 0.5, f"Perfect ranking should have high Gini, got {gini:.4f}"

    def test_alert_not_triggered_with_few_records(self):
        """Alert should not trigger with less than 50 resolved records."""
        router = self._get_router()
        alert = router.check_challenger_alert()
        assert alert is None


# ── Updated Worker Integration Tests ─────────────────────────────────────────

GOOD_JOB_DATA = {
    "loanId": "test-loan-001",
    "userId": "user-abc",
    "employerId": "employer-xyz",
    "principalAmount": 1500,
    "borrowerSnapshot": {
        "employmentTenureMonths": 36,
        "monthlySalary": 22000,
        "payFrequency": "biweekly",
        "employerIndustry": "manufacturing",
        "curpHash": "abc123",
        "fullName": "Juan Pérez López",
        "riskSealScore": 70,
        "employerTier": 2,
        "sectorRisk": 2,
        "aforeRegularity": 0.85,
        "belvoCashFlowAvg": 18000,
        "employerScore": 65,
        "payrollRegularity": 0.80,
    },
}

LOW_TENURE_JOB_DATA = {
    **GOOD_JOB_DATA,
    "loanId": "test-loan-low-tenure",
    "borrowerSnapshot": {
        **GOOD_JOB_DATA["borrowerSnapshot"],
        "employmentTenureMonths": 1,
    },
}


def make_job(data: dict):
    job = MagicMock()
    job.data = data
    job.id = data["loanId"]
    return job


@pytest.mark.asyncio
async def test_worker_returns_champion_challenger_scores():
    """Worker should return both champion and challenger scores."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch(
            "workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock
        ),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        result = await process_underwrite_loan(make_job(GOOD_JOB_DATA))

    assert "score" in result
    assert "challengerScore" in result
    assert "shapTop5" in result
    assert isinstance(result["shapTop5"], list)
    assert 0.0 <= result["score"] <= 1.0
    assert 0.0 <= result["challengerScore"] <= 1.0


@pytest.mark.asyncio
async def test_worker_stores_shap_in_firestore():
    """Worker should store SHAP top-5 in Firestore update payload."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch(
            "workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock
        ),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        await process_underwrite_loan(make_job(GOOD_JOB_DATA))

    firestore_mock.update_loan.assert_called_once()
    update_args = firestore_mock.update_loan.call_args[0]
    payload = update_args[1]
    assert "shapTop5" in payload
    assert "challengerScore" in payload
    assert "challengerModel" in payload
    assert payload["underwritingModel"] == "scorecard_champion_v2.0"


@pytest.mark.asyncio
async def test_worker_low_tenure_still_rejected():
    """Low tenure borrower should be hard rejected regardless of model scores."""
    from workers.underwriting_worker import process_underwrite_loan

    firestore_mock = MagicMock()
    firestore_mock.update_loan = MagicMock(return_value=None)
    firestore_mock.array_union = MagicMock(return_value={})

    redis_mock = AsyncMock()
    redis_mock.lpush = AsyncMock(return_value=1)
    redis_mock.aclose = AsyncMock()

    with (
        patch("workers.underwriting_worker.get_firestore", return_value=firestore_mock),
        patch(
            "workers.underwriting_worker.AsyncRedis.from_url", return_value=redis_mock
        ),
        patch.dict(os.environ, {"REDIS_URL": "redis://localhost:6379"}),
    ):
        result = await process_underwrite_loan(make_job(LOW_TENURE_JOB_DATA))

    assert result["decision"] == "rejected"
    update_args = firestore_mock.update_loan.call_args[0]
    assert update_args[1]["status"] == "rejected"
    assert "tenure" in (update_args[1].get("rejectionReason") or "").lower()

    # No disbursement should be pushed
    calls = [call[0][0] for call in redis_mock.lpush.call_args_list]
    assert "jobs:notifications" in calls
    assert "jobs:disbursements" not in calls
