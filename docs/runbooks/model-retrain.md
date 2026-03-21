# Model Retraining Runbook

> VIDA Finance v1.7 — ML Operations

## Model Inventory

| Model | Type | Role | Service | Retrain Cadence |
|-------|------|------|---------|-----------------|
| WoE LR v2 | Logistic Regression (WoE) | Champion scorecard | ml-service | Quarterly |
| XGBoost | Gradient Boosting | Challenger (shadow) | ml-service | Quarterly |
| Autoencoder v2 | Neural Network (7 features) | Anomaly detection | ml-service | Monthly threshold review |
| Claude LLM | Prompt template v1.7.0 | LLM judge | ml-service | As needed |

## Retraining Triggers

Retrain when **any** of these conditions are met:

- **PSI drift** — Population Stability Index > 0.2 for any feature (checked weekly via scheduled job)
- **CSI drift** — Characteristic Stability Index > 0.25 for any scorecard variable
- **Performance decay** — KS statistic drops below 0.30 or Gini below 0.40
- **Quarterly schedule** — regardless of drift metrics
- **Regulatory request** — CNBV audit or compliance review

## Champion Model Retraining (WoE LR v2)

### Step 1: Data Preparation

1. Export loan outcomes from Firestore (minimum 6 months of performance data):
   ```
   Collections: loans, loan_outcomes, credit_bureau_snapshots
   ```
2. Join with feature store data from Redis/Firestore
3. Define target variable: `default_90dpd` (90 days past due)
4. Apply exclusion rules:
   - Remove loans with < 90 days since disbursement (immature)
   - Remove fraud-confirmed applications
   - Remove test/internal loans

### Step 2: Feature Engineering

1. Recalculate Weight of Evidence (WoE) bins for all features:
   - Bureau score bands
   - Income-to-debt ratio bands
   - Employment tenure bands
   - SoftCrédito payment history bands
   - Belvo account balance bands
   - RiskSeal digital footprint score bands
   - Autoencoder anomaly score bands
2. Calculate Information Value (IV) for each feature
3. Drop features with IV < 0.02 (not predictive) or IV > 0.5 (suspicious/overfit)
4. Document bin boundaries for production deployment

### Step 3: Model Training

1. Split data: 70% train / 30% test (time-based split, not random)
2. Fit logistic regression on WoE-transformed features
3. Calibrate scorecard points: base score 600, PDO 20, target odds 50:1
4. Validate:
   - KS statistic ≥ 0.35
   - Gini ≥ 0.45
   - AUC-ROC ≥ 0.75
   - Lift in top decile ≥ 3x
5. Generate SHAP values for explainability (required for CNBV adverse action notices)

### Step 4: Challenger Comparison

1. Compare new champion candidate against current champion on holdout set
2. Compare against XGBoost challenger shadow results
3. Document: accuracy, KS, Gini, approval rate impact, expected loss rate
4. If XGBoost outperforms LR by > 5% Gini, flag for champion swap discussion

### Step 5: Approval & Deployment

1. Prepare model validation report with all metrics
2. Submit for review:
   - Engineering lead sign-off (technical)
   - Risk/compliance sign-off (regulatory)
3. Save new PSI/CSI baselines from the training data
4. Deploy to ml-service:
   - Update model artifacts in the service
   - Update WoE bin boundaries in configuration
   - Update scorecard point mappings
5. Deploy in shadow mode first (48 hours minimum)
6. Compare shadow predictions against production model
7. If validated, promote to champion:
   - Update model version in ml-service config
   - Update Claude LLM prompt template if scoring logic changed
8. Monitor PSI daily for 2 weeks post-deployment

## XGBoost Challenger Retraining

Follow Steps 1–3 above with these differences:

- Use raw features (no WoE transformation)
- Hyperparameter tuning: grid search over `max_depth`, `learning_rate`, `n_estimators`
- Apply monotonic constraints for regulatory compliance
- XGBoost always runs in shadow mode — never as champion without explicit approval
- Compare SHAP explanations against champion scorecard for consistency

## Autoencoder Threshold Calibration

### Monthly Review

1. Pull autoencoder anomaly scores for the past 30 days
2. Calculate score distribution statistics (mean, std, percentiles)
3. Compare against v2 baseline distribution
4. If distribution has shifted:
   - Recalculate threshold at 95th percentile of known-good applications
   - Validate false positive rate is < 5%
   - Update threshold in ml-service configuration
5. If 7-feature input distribution has changed significantly, retrain the autoencoder:
   - Use same architecture (7-input, bottleneck, 7-output)
   - Train on known-good applications only
   - Validate reconstruction error distribution

## Claude LLM Prompt Template Updates

1. Prompt template is versioned (current: v1.7.0)
2. Changes require:
   - A/B test with historical decisions
   - Review for regulatory compliance (CNBV language requirements)
   - Spanish-language SHAP explanation accuracy check
3. Update `CLAUDE_PROMPT_VERSION` in ml-service environment
4. Monitor LLM judge agreement rate with champion model for 1 week

## PSI/CSI Monitoring

The PSI weekly job runs automatically. Manual check:

1. Pull current feature distributions from production
2. Compare against saved baseline distributions
3. Calculate PSI per feature: `PSI = Σ (actual% - expected%) × ln(actual% / expected%)`
4. Thresholds:
   - PSI < 0.1 — No action needed
   - 0.1 ≤ PSI < 0.2 — Monitor closely, investigate cause
   - PSI ≥ 0.2 — Trigger retraining cycle
5. Log results and notify engineering lead if any feature exceeds 0.1

## Rollback Procedure

If a newly deployed model causes issues:

1. Revert ml-service to previous model artifacts
2. Restore previous WoE bins / thresholds
3. Restart ml-service
4. Verify predictions match expected distribution
5. Document incident and root cause
