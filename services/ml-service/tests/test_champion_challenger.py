"""
Tests for the WoE scorecard champion, XGBoost challenger, and
champion/challenger router.

Covers:
  - Scorecard model loading, WoE transform, predict_proba, predict_score
  - XGBoost model loading, predict_proba, SHAP explanations
  - Champion/challenger router: dual prediction, SHAP top-5, promotion check
  - Worker v2 feature engineering
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

CHAMPION_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "scorecard_champion_v2.joblib")
CHALLENGER_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "xgb_challenger_v2.joblib")

# ── Shared test fixtures ─────────────────────────────────────────────────────

GOOD_BORROWER = {
    "scDiasAtraso": 0,
    "cdcScore": 720,
    "carteraVencida": 0,
    "imss_tenure_months": 36,
    "lti": 0.08,
    "riskSeal_score": 15,
    "employer_tier": 1,
    "sector_risk": 0.2,
    "afore_regularity": 0.9,
    "monthly_salary": 25000,
    "scCuentasActivas": 2,
    "belvo_cash_flow_avg": 22000,
    "employer_score": 80,
    "payroll_regularity": 0.95,
}

RISKY_BORROWER = {
    "scDiasAtraso": 60,
    "cdcScore": 380,
    "carteraVencida": 8000,
    "imss_tenure_months": 2,
    "lti": 0.45,
    "riskSeal_score": 75,
    "employer_tier": 3,
    "sector_risk": 0.7,
    "afore_regularity": 0.2,
    "monthly_salary": 8000,
    "scCuentasActivas": 8,
    "belvo_cash_flow_avg": 4000,
    "employer_score": 25,
    "payroll_regularity": 0.3,
}


# ── Scorecard model tests ───────────────────────────────────────────────────

class TestScorecardModel:

    def test_model_loads(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        assert model is not None
        assert model.version == "scorecard_champion_v2.0"
        assert len(model.FEATURE_ORDER) == 10

    def test_woe_transform_returns_correct_shape(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        woe_vector = model.transform_to_woe(GOOD_BORROWER)
        assert woe_vector.shape == (10,)
        assert woe_vector.dtype == np.float64

    def test_predict_proba_good_borrower(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        prob = model.predict_proba(GOOD_BORROWER)
        assert 0.0 <= prob <= 1.0
        assert prob >= 0.55, f"Good borrower should have high repayment prob, got {prob:.3f}"

    def test_predict_proba_risky_borrower(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        prob = model.predict_proba(RISKY_BORROWER)
        assert 0.0 <= prob <= 1.0
        assert prob <= 0.50, f"Risky borrower should have low repayment prob, got {prob:.3f}"

    def test_predict_proba_ordering(self):
        """Good borrower should always score higher than risky borrower."""
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        good_prob = model.predict_proba(GOOD_BORROWER)
        risky_prob = model.predict_proba(RISKY_BORROWER)
        assert good_prob > risky_prob

    def test_predict_score_range(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        score = model.predict_score(GOOD_BORROWER)
        assert 300 <= score <= 900

    def test_iv_values_stored(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        assert "scDiasAtraso" in model.iv_values
        assert "imss_tenure_months" in model.iv_values
        # At least some features should have IV >= 0.1
        strong_features = [f for f, iv in model.iv_values.items() if iv >= 0.1]
        assert len(strong_features) >= 2, f"Expected ≥2 features with IV≥0.1, got {strong_features}"

    def test_woe_bins_structure(self):
        from models.scorecard_model import ScorecardModel
        model = ScorecardModel.load(CHAMPION_PATH)
        for feat in model.FEATURE_ORDER:
            bins = model.woe_bins[feat]
            assert len(bins) >= 2, f"{feat} should have ≥2 WoE bins"
            # Bins should be sorted by upper bound
            for i in range(1, len(bins)):
                assert bins[i][0] >= bins[i - 1][0], f"{feat} bins not sorted"


# ── XGBoost model tests ─────────────────────────────────────────────────────

class TestXGBoostModel:

    def test_model_loads(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        assert model is not None
        assert model.version == "xgb_challenger_v2.0"
        assert len(model.FEATURE_ORDER) == 14

    def test_predict_proba_good_borrower(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        prob = model.predict_proba(GOOD_BORROWER)
        assert 0.0 <= prob <= 1.0
        assert prob >= 0.55, f"Good borrower should have high repayment prob, got {prob:.3f}"

    def test_predict_proba_risky_borrower(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        prob = model.predict_proba(RISKY_BORROWER)
        assert 0.0 <= prob <= 1.0
        assert prob <= 0.50, f"Risky borrower should have low repayment prob, got {prob:.3f}"

    def test_predict_proba_ordering(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        good_prob = model.predict_proba(GOOD_BORROWER)
        risky_prob = model.predict_proba(RISKY_BORROWER)
        assert good_prob > risky_prob

    def test_shap_explanations(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        shap_top5 = model.explain(GOOD_BORROWER, top_n=5)
        assert len(shap_top5) == 5
        for entry in shap_top5:
            assert "feature" in entry
            assert "shap_value" in entry
            assert "raw_value" in entry
            assert entry["feature"] in model.FEATURE_ORDER

    def test_shap_sorted_by_absolute_value(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        shap_top5 = model.explain(RISKY_BORROWER, top_n=5)
        abs_values = [abs(e["shap_value"]) for e in shap_top5]
        assert abs_values == sorted(abs_values, reverse=True)

    def test_shap_top_feature_is_sc_dias_atraso_for_risky(self):
        """scDiasAtraso should be the top SHAP feature for a highly delinquent borrower."""
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        # Use a borrower where scDiasAtraso is extreme
        extreme = {**GOOD_BORROWER, "scDiasAtraso": 90}
        shap_top5 = model.explain(extreme, top_n=5)
        assert shap_top5[0]["feature"] == "scDiasAtraso", (
            f"Expected scDiasAtraso as top feature, got {shap_top5[0]['feature']}"
        )

    def test_predict_proba_raw(self):
        from models.xgb_model import XGBoostChallengerModel
        model = XGBoostChallengerModel.load(CHALLENGER_PATH)
        raw = model.predict_proba_raw(GOOD_BORROWER)
        assert 0.0 <= raw <= 1.0


# ── Router tests ─────────────────────────────────────────────────────────────

class TestChampionChallengerRouter:

    def test_router_loads(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        assert router.champion.version == "scorecard_champion_v2.0"
        assert router.challenger.version == "xgb_challenger_v2.0"

    def test_predict_returns_both_scores(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        result = router.predict(GOOD_BORROWER)

        assert "champion_prob" in result
        assert "challenger_prob" in result
        assert "champion_model" in result
        assert "challenger_model" in result
        assert "champion_score" in result
        assert "shap_top5" in result

        assert 0.0 <= result["champion_prob"] <= 1.0
        assert 0.0 <= result["challenger_prob"] <= 1.0
        assert 300 <= result["champion_score"] <= 900
        assert len(result["shap_top5"]) == 5

    def test_predict_good_borrower_approved(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        result = router.predict(GOOD_BORROWER)
        assert result["champion_prob"] >= 0.55

    def test_predict_risky_borrower_rejected(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        result = router.predict(RISKY_BORROWER)
        assert result["champion_prob"] <= 0.50

    def test_promotion_check_insufficient_data(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        # No labels recorded yet
        promo = router.check_promotion()
        assert promo["should_promote"] is False
        assert "Insufficient" in promo["reason"]

    def test_promotion_check_with_labeled_data(self):
        from models.router import ChampionChallengerRouter, PredictionRecord
        import time

        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)

        # Directly populate history with labeled records to avoid timestamp matching issues
        base_time = time.time()
        for i in range(60):
            features = GOOD_BORROWER if i % 2 == 0 else RISKY_BORROWER
            champion_prob = router.champion.predict_proba(features)
            challenger_prob = router.challenger.predict_proba(features)
            record = PredictionRecord(
                timestamp=base_time + i,
                champion_prob=champion_prob,
                challenger_prob=challenger_prob,
                actual_label=1.0 if i % 2 == 0 else 0.0,
            )
            router._history.append(record)

        promo = router.check_promotion()
        assert promo["labeled_count"] == 60
        assert promo["champion_gini"] is not None
        assert promo["challenger_gini"] is not None

    def test_history_records_predictions(self):
        from models.router import ChampionChallengerRouter
        router = ChampionChallengerRouter.load(CHAMPION_PATH, CHALLENGER_PATH)
        router.predict(GOOD_BORROWER)
        router.predict(RISKY_BORROWER)
        assert len(router._history) == 2


# ── Worker v2 feature engineering tests ──────────────────────────────────────

class TestBuildV2Features:

    def test_build_v2_features_with_bureau(self):
        from workers.underwriting_worker import build_v2_features

        borrower = {
            "employmentTenureMonths": 24,
            "monthlySalary": 20000,
            "employerIndustry": "manufacturing",
            "riskSealScore": 30,
            "employerTier": 1,
            "aforeRegularity": 0.8,
            "belvoCashFlowAvg": 18000,
            "employerScore": 70,
            "payrollRegularity": 0.9,
        }
        bureau = {
            "diasAtraso": 5,
            "riskScore": 650,
            "carteraVencida": 0,
            "cuentasActivas": 3,
            "found": True,
        }

        features = build_v2_features(borrower, 2000, 20000, bureau)
        assert features["scDiasAtraso"] == 5.0
        assert features["cdcScore"] == 650.0
        assert features["carteraVencida"] == 0.0
        assert features["imss_tenure_months"] == 24.0
        assert features["lti"] == 0.1
        assert features["employer_tier"] == 1.0
        assert features["sector_risk"] == 0.3  # manufacturing
        assert features["scCuentasActivas"] == 3.0

    def test_build_v2_features_without_bureau(self):
        from workers.underwriting_worker import build_v2_features

        borrower = {
            "employmentTenureMonths": 12,
            "monthlySalary": 15000,
            "employerIndustry": "retail",
        }

        features = build_v2_features(borrower, 1500, 15000, None)
        assert features["scDiasAtraso"] == 0.0
        assert features["cdcScore"] == 500.0  # default
        assert features["carteraVencida"] == 0.0
        assert features["sector_risk"] == 0.5  # retail

    def test_build_v2_features_unknown_industry(self):
        from workers.underwriting_worker import build_v2_features

        borrower = {"employmentTenureMonths": 6, "monthlySalary": 10000}
        features = build_v2_features(borrower, 1000, 10000, None)
        assert features["sector_risk"] == 0.5  # default for unknown
