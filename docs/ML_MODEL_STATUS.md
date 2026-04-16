# ML Model Status Report

**Date:** 2026-04-16
**Ticket:** VID3-661 (parent: VID3-645)
**Outcome:** **B — Models are mechanically functional but trained on synthetic data only**

---

## Check 1: Model Inventory

### Model files in `services/ml-service/models/`

| File | Size | Type | Assessment |
|------|------|------|------------|
| `scorecard_champion_v2.joblib` | 4,037 B | WoE Scorecard + Logistic Regression | Loads correctly. 10 features with WoE bins. Small but plausible for LR. |
| `xgb_challenger_v2.joblib` | 428,223 B | XGBoost + Platt calibration | Loads correctly. 14 features, 200 estimators. Reasonable size. |
| `autoencoder_v2_metamap.pt` | 3,764 B | PyTorch autoencoder (7-4-2-4-7) | Loads correctly. Tiny architecture for 7 MetaMap device signals. |
| `underwriting_v1.joblib` | 1,011 B | Legacy logistic regression baseline | Baseline model, not used in production pipeline. |

### Python packages (from `requirements.txt`)

| Package | Version | Status |
|---------|---------|--------|
| xgboost | 2.0.3 | Present |
| scikit-learn | 1.4.0 | Present |
| shap | 0.44.0 | Present |
| torch | >=2.2.0 | Present |
| evidently | 0.4.16 | Present (drift monitoring) |
| modAL-python | 0.4.2.1 | Present (active learning) |
| faiss-cpu | 1.8.0 | Present (thin-file kNN) |

### Model architecture

The service implements a 6-stage pipeline:

1. **Stage 0** — Isolation Forest fraud pre-screen (8 velocity/device features)
2. **Stage 1** — Bureau enrichment via SoftCredito adapter
3. **Stage 2** — Feature engineering (`build_model_features`)
4. **Stage 3** — Champion/Challenger models (`ModelRouter.predict`)
   - Champion: WoE scorecard (10 features) — makes the decision
   - Challenger: XGBoost (14 features) — shadow logging + SHAP top-5
5. **Stage 4** — MetaMap autoencoder anomaly detection (7 device signals)
6. **Stage 5** — Active learning human-review routing (uncertainty sampling)

Plus hard business rules (employment tenure < 3 months override).

**Check 1 verdict:** Models exist, load, and are architecturally sound.

---

## Check 2: Prediction Behavior Analysis

### Endpoints

| Endpoint | Backend | ML Model Used? |
|----------|---------|---------------|
| `POST /score` | `ModelRouter.predict()` | Yes — champion + challenger |
| `POST /underwrite/employee` | `scoring.employee_score()` | **No** — purely rule-based |
| `POST /underwrite/employer` | `scoring.employer_score()` | **No** — purely rule-based + optional LLM |
| BullMQ `vida-underwriting` worker | `ModelRouter.predict()` | Yes — full 6-stage pipeline |

### Will models produce varied predictions?

**Yes.** The champion (WoE scorecard) transforms features through learned WoE bins before logistic regression scoring. The challenger (XGBoost) uses 200 tree estimators with Platt calibration. Both will produce different scores for different inputs.

SHAP explanations are computed via `shap.TreeExplainer` on the raw XGBoost model — this is genuine SHAP, not stubbed.

### Critical finding: models were trained on synthetic data

Both training scripts (`scripts/train_scorecard_champion.py` and `scripts/train_xgb_challenger.py`) generate synthetic data using `generate_synthetic_data()`:

- **10,000 synthetic samples** with hand-coded feature distributions
- **Target variable** derived from a manually crafted scoring formula with hard-coded thresholds (e.g., `cdcScore > 700 = good`, `imss_tenure_months < 6 = bad`)
- **No real loan performance data** was used
- The models effectively learn the hand-coded rules in the data generator, not empirical default patterns

This means:
- The models **will** vary by input (they're real ML models)
- The models **will** generate SHAP values
- The models' risk discrimination is based on **assumed heuristics**, not actual repayment outcomes
- There is **no empirical evidence** that the approval threshold (0.65) produces acceptable default rates

### Endpoint note

The `/underwrite/employee` and `/underwrite/employer` endpoints bypass ML entirely — they use `scoring.py` which is pure rule-based logic returning `"model": "rule_based"`. Only `/score` and the BullMQ worker use the ML pipeline.

**Check 2 verdict:** Models are mechanically functional and produce varied predictions, but their credit risk discrimination is not empirically validated.

---

## Check 3: Backtest Evidence

| Artifact | Found? |
|----------|--------|
| `backtests/` directory | No |
| Jupyter notebooks (`*.ipynb`) | None |
| Training data CSVs | None |
| Model card / model README | None |
| Validation reports | None |
| Historical loan performance data | None |

The only training artifacts are:
- `scripts/train_scorecard_champion.py` — generates synthetic data inline
- `scripts/train_xgb_challenger.py` — generates synthetic data inline
- `scripts/train_autoencoder.py` — uses synthetic + optional Firestore shadow logs
- `models/baselines/v1_baseline.json` — baseline statistics (also from synthetic data, n=5000)

**Check 3 verdict:** Zero backtest evidence. No real training data exists in the repository.

---

## Outcome Assessment

### Outcome B: Models are functional but trained on synthetic data

The ML stack is **architecturally complete and mechanically functional**:
- Models load, score, and produce varied predictions
- SHAP explanations work correctly
- Champion/challenger routing, drift monitoring, and active learning are implemented
- The 6-stage pipeline is well-structured

However, the models are **not empirically validated**:
- All training used synthetic data with hand-coded scoring rules
- The models effectively replicate the developers' assumptions about risk, not actual default patterns
- There is no backtest, no validation dataset, no model card, no historical evidence
- The approval threshold (0.65) has no empirical basis

### Risk for production launch

Using these models in production for autonomous approval/rejection of loans is **high-risk** because:
1. No one knows the actual default rate these models will produce
2. The approval threshold was not calibrated against real outcomes
3. The WoE bins were computed from synthetic distributions, not real bureau data
4. There is no benchmark to detect model degradation (drift monitoring exists but baseline is also synthetic)

### Recommendation

**Option B2: Manual review for all** — Set `ML_MODE=manual_review_all` for pilot launch.

Rationale:
- The ML infrastructure is solid and can be upgraded in-place once real data exists
- For a <50 loans/day pilot, human review is viable and builds the labeled dataset needed to retrain
- After collecting ~500 resolved loans (repaid vs defaulted), retrain on real data
- This avoids launch delay while protecting against unknown default rates

### Follow-up actions

1. **Immediate:** Set `ML_MODE=manual_review_all` or configure active learner to route 100% to human review
2. **Immediate:** Add Prometheus instrumentation to ml-service (VID3-662)
3. **Short-term:** Collect labeled loan outcomes in Firestore for future model retraining
4. **Medium-term (after ~500 resolved loans):** Retrain champion/challenger on real data, validate with proper backtest
5. **Escalate to Isaac:** Go/no-go decision on launching with manual review vs delay

---

## Appendix: File inventory

### Model files
- `services/ml-service/models/scorecard_champion_v2.joblib` (4 KB)
- `services/ml-service/models/xgb_challenger_v2.joblib` (418 KB)
- `services/ml-service/models/autoencoder_v2_metamap.pt` (3.7 KB)
- `services/ml-service/models/underwriting_v1.joblib` (1 KB)

### Model code
- `services/ml-service/models/scorecard_model.py` — WoE Scorecard Champion
- `services/ml-service/models/xgb_model.py` — XGBoost Challenger + Platt calibration
- `services/ml-service/models/champion_challenger.py` — ModelRouter
- `services/ml-service/models/autoencoder.py` — MetaMap anomaly detector
- `services/ml-service/models/isolation_forest.py` — Fraud pre-screen
- `services/ml-service/models/active_learner.py` — Human review routing
- `services/ml-service/models/thin_file_knn.py` — Thin-file scoring
- `services/ml-service/models/drift_monitor.py` — PSI/CSI drift detection

### Training scripts
- `services/ml-service/scripts/train_scorecard_champion.py`
- `services/ml-service/scripts/train_xgb_challenger.py`
- `services/ml-service/scripts/train_autoencoder.py`
- `services/ml-service/scripts/train_isolation_forest.py`

### Service endpoints
- `POST /score` — ML-backed scoring (champion + challenger)
- `POST /underwrite/employee` — Rule-based employee scoring
- `POST /underwrite/employer` — Rule-based employer scoring + optional LLM
- `GET /explain/{decision_id}` — SHAP explanation retrieval
- `POST /monitor/drift` — Trigger drift analysis
- `GET /monitor/drift/latest` — Latest drift report
- `GET /health` — Service health check
