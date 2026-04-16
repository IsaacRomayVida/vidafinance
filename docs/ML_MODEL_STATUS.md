# ML Model Status — VID3-645 Verification

**Date:** 2026-04-16
**Verified by:** Code inspection (runtime verification pending — see Checks section)

## 1. Model Inventory

| Artifact | Path | Type | Status |
|---|---|---|---|
| Champion (WoE scorecard) | `models/scorecard_champion_v2.joblib` | WoE logistic regression | Present on disk |
| Challenger (XGBoost) | `models/xgb_challenger_v2.joblib` | XGBoost + Platt calibration | Present on disk |
| Autoencoder (Stage 4 fraud) | `models/autoencoder_v2_metamap.pt` | PyTorch autoencoder | Present on disk |
| Baseline (legacy) | `models/underwriting_v1.joblib` | Logistic regression | Present on disk |
| Isolation Forest (Stage 0) | `models/isolation_forest_v1.joblib` | Isolation Forest | **Not present** (optional, graceful degradation) |
| Active Learner (Stage 5) | `models/active_learner_v1.joblib` | modAL active learner | **Not present** (optional, graceful degradation) |
| Drift baseline | `models/baselines/v1_baseline.json` | Feature distributions | Present on disk |

## 2. Champion Model — WoE Scorecard v2.0

**Architecture:** Weight of Evidence (WoE) transformed features + logistic regression

**Feature set (10 features):**

| Feature | Description | Source |
|---|---|---|
| `scDiasAtraso` | Days past due (bureau) | SoftCredito |
| `cdcScore` | Credit bureau risk score | SoftCredito |
| `carteraVencida` | Overdue portfolio balance | SoftCredito |
| `imss_tenure_months` | IMSS employment tenure | Borrower snapshot |
| `lti` | Loan-to-income ratio | Computed (principal / salary) |
| `riskSeal_score` | RiskSeal device/identity score | Borrower snapshot |
| `employer_tier` | Employer risk tier (1-3) | Employer scoring |
| `sector_risk` | Industry sector risk (1-5) | Employer scoring |
| `afore_regularity` | AFORE contribution regularity | Borrower snapshot |
| `monthly_salary` | Monthly net salary (MXN) | Borrower snapshot |

**Decision logic:** Champion returns P(repayment) in [0, 1]. If score >= `APPROVAL_THRESHOLD` (default 0.65), decision = "approved", otherwise "rejected".

**Hard rule overrides applied after scoring:**
- Employment tenure < 3 months -> rejected
- Stage 0 Isolation Forest fraud flag -> rejected (if model loaded)

## 3. Challenger Model — XGBoost v2.0

**Architecture:** XGBoost with Platt scaling (CalibratedClassifierCV) for calibrated probabilities

**Feature set (14 features):** All 10 champion features plus:

| Feature | Description | Source |
|---|---|---|
| `scCuentasActivas` | Active credit accounts (bureau) | SoftCredito |
| `belvo_cash_flow_avg` | Avg cash flow from open banking | Belvo |
| `employer_score` | Employer ML score | Employer scoring |
| `payroll_regularity` | Payroll deposit regularity | Borrower snapshot |

**SHAP explanations:** Uses `shap.TreeExplainer` on the raw XGBoost model. Returns top-5 feature contributions per prediction.

**Role:** Shadow mode only. Runs on every prediction but the champion's decision is authoritative. A 30-day rolling Gini comparison alerts if the challenger outperforms the champion by >= 0.02.

## 4. Multi-Stage Pipeline

| Stage | Component | Status |
|---|---|---|
| Stage 0 | Isolation Forest fraud pre-screen | Optional — model file not present, gracefully skipped |
| Stage 1 | SoftCredito bureau enrichment | Active — graceful degradation on timeout/error |
| Stage 2 | Feature engineering | Active — defaults used when bureau unavailable |
| Stage 3 | Champion/Challenger scoring | Active — both models loaded and scored |
| Stage 4 | Autoencoder fraud detection | Model present — used in employee scoring path |
| Stage 5 | Active learner human-review routing | Optional — model file not present, gracefully skipped |

## 5. Scoring Endpoints

- **`POST /score`** — Synchronous scoring. Runs champion + challenger, returns decision + SHAP top-5.
- **BullMQ worker (`vida-underwriting` queue)** — Async pipeline. Full 6-stage underwriting with Firestore writes and downstream job dispatch.

Both paths now instrumented with Prometheus metrics (`ml_predictions_total`, `ml_prediction_latency_seconds`).

## 6. Backtest Evidence

**Status: NONE**

- No `backtests/` directory exists
- No training notebooks (`.ipynb`) found in the service
- No CSV/JSON backtest results
- No model card or training data documentation
- Training scripts exist in `scripts/` but no output artifacts documenting training data source, sample size, date range, or demographic bias checks

**Implication:** We cannot verify that the 0.65 approval threshold is calibrated against actual default rates. The threshold may be reasonable for the feature set, but there is no empirical evidence.

## 7. Known Gaps

1. **No backtest/calibration data** — The approval threshold (0.65) is not empirically validated against historical loan outcomes.
2. **No training data provenance** — Unknown: training data source, sample size, date range, demographic composition.
3. **No 2024-2025 recalibration** — Model versions are "v2.0" but it is unclear when they were last trained or on what data vintage.
4. **Stage 0 (Isolation Forest) not deployed** — Model file missing. Fraud pre-screening is skipped entirely.
5. **Stage 5 (Active Learner) not deployed** — Model file missing. Uncertainty-based human review routing is skipped.
6. **Bureau enrichment dependency** — If SoftCredito is down, features default to neutral values (e.g., `cdcScore=500`, `scDiasAtraso=0`), which biases scores upward.
7. **No champion/challenger promotion workflow** — The Gini comparison alerts but there is no automated model swap.

## 8. Prometheus Instrumentation (Added VID3-645)

| Metric | Type | Labels | Description |
|---|---|---|---|
| `ml_predictions_total` | Counter | `decision`, `model_version` | Total predictions by outcome |
| `ml_prediction_latency_seconds` | Histogram | — | End-to-end prediction latency |
| `ml_model_info` | Info | `champion`, `challenger` | Currently loaded model versions |

Exposed at `GET /metrics` for Prometheus scraping. Grafana dashboard updated with 3 ML panels.

## 9. Runtime Verification Checks (Pending)

The following checks require Railway access and should be run before launch:

### Check 1 — Model loads with real features
```bash
railway run -s ml-service python -c "
from models.champion_challenger import ModelRouter
r = ModelRouter.load('models/scorecard_champion_v2.joblib', 'models/xgb_challenger_v2.joblib')
print('Champion:', r.champion.version, '| features:', r.champion.selected_features)
print('Challenger:', r.challenger.version, '| features:', r.challenger.feature_names)
"
```

### Check 2 — /predict returns varied scores for different inputs
Hit `/score` with a low-risk profile (bureau_score=720, tenure=36mo) and a high-risk profile (bureau_score=300, tenure=2mo). Scores must differ.

### Check 3 — SHAP explanations render
Confirm `shapTop5` in `/score` response contains 5 entries with non-zero `shap_value` fields.

## 10. Go / No-Go Recommendation

**Recommendation: Conditional Go — launch with enhanced manual review**

**Rationale:**
- The model artifacts are present and the code implements a real dual-model scoring pipeline (not stubs).
- WoE scorecard + XGBoost with SHAP is a sound architecture for credit scoring.
- However, the lack of backtest evidence and calibration data means we cannot confirm the threshold produces acceptable default rates.

**Conditions for v1.8 launch:**
1. Run Check 1-3 above to confirm models load and score in production.
2. If scores vary by input: launch with current models but route all loans with `probability_default > 0.10` to manual review for the first 100 loans (see VID3-566 ops queue).
3. If scores do NOT vary or models fail to load: launch in `ML_MODE=manual_review_all` mode — every loan goes to ops queue.
4. Collect labeled data (repaid vs. defaulted) during pilot to calibrate and validate the threshold for v1.9.

**Follow-up for v1.9:**
- Train on pilot labeled data and publish a model card with calibration curves
- Deploy Isolation Forest (Stage 0) and Active Learner (Stage 5) models
- Establish quarterly recalibration cadence
