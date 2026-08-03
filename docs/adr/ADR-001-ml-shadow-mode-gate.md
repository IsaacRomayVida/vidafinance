# ADR-001 — ML models run shadow-only until empirically validated

- **Status:** ACCEPTED
- **Date:** 2026-08-02
- **Decider:** Funpay CTO, on Isaac's instruction to "do what best practice tells you"
- **Scope:** `services/ml-service`, `services/underwriting-service` decision path

## Context

Every model in `services/ml-service/models/` is trained on `generate_synthetic_data()`:
10,000 synthetic rows whose target labels are produced by a hand-coded formula
(`cdcScore > 700 = good`, `imss_tenure_months < 6 = bad`, etc.).

Verified 2026-08-02, still true on `main` @ 7debed7:
- All 7 training scripts in `services/ml-service/scripts/` generate synthetic data
- No `backtests/` directory, no notebooks, no training CSVs, no model card,
  no historical loan performance data anywhere in the repo
- `models/baselines/v1_baseline.json` is itself synthetic (n=5000)

The models are *mechanically* sound — they load, they discriminate between inputs,
champion/challenger routing works, and SHAP via `shap.TreeExplainer` is genuine, not
stubbed. The problem is not the code. The problem is that the models have learned the
data generator's assumptions rather than actual borrower repayment behaviour.

**The operative risk:** the 0.65 approval threshold has no empirical basis. Nothing in
the repo establishes what default rate it produces. Lending real money against it is
an uncontrolled bet, and explaining CNBV adverse-action notices with SHAP values drawn
from a model fitted to invented outcomes is a compliance exposure on top of a credit one.

## Decision

**ML gets no decision authority until it is validated against real repayment outcomes.**

1. **Rules-based decides.** `scoring.employee_score()` / `scoring.employer_score()` remain
   authoritative. Note these endpoints (`/underwrite/employee`, `/underwrite/employer`)
   are *already* pure rule-based — so this is largely codifying today's reality rather
   than a rewrite.
2. **ML runs in shadow.** The `/score` endpoint and the `vida-underwriting` BullMQ worker
   continue to execute the full 6-stage pipeline, but their output is **logged, not obeyed**.
   Every shadow prediction is persisted alongside the rule-based decision that was actually
   applied, plus the eventual repayment outcome.
3. **Promotion is gated, not scheduled.** ML may take decision authority only when a
   documented backtest on real outcomes shows acceptable discrimination (AUC/KS) and a
   calibrated threshold with a known default rate — reviewed and signed off explicitly.
   No date-based promotion. No "it's been running a while, let's flip it."
4. **The gate is enforced in code, not convention.** A single explicit flag controls ML
   authority, defaulting to shadow. It must not be flippable by config drift or an
   env var nobody reviews.

## Consequences

**Good:**
- Launch is unblocked without pretending the models are validated.
- The training set accumulates as a byproduct of operating — every real loan generates a
  (features, shadow prediction, rule decision, outcome) tuple. This is the cheapest
  possible path to a defensible model.
- Adverse-action explanations trace to rules we can actually articulate to a regulator.

**Bad / accepted:**
- Approval quality is capped at what hand-written rules achieve until promotion.
- Someone must own the shadow-log → training-set pipeline or the data rots unused.
- Carrying both paths costs some complexity in the underwriting service.

## Rejected alternatives

- **Ship ML with authority as-is.** Rejected: unquantified default risk plus CNBV exposure.
- **Buy bureau performance data to fit against** (Círculo de Crédito / SoftCrédito).
  Not rejected outright — worth pursuing in parallel as it is the fastest route to a
  defensible model. But it costs money and contract time, so it cannot gate launch.
- **Manual-underwrite pilot before any automation.** Safest and the standard path for a
  new lender, but strictly slower than shadow mode while producing the same data.
  Effectively what shadow mode gives us, minus the delay.

## Follow-up work

- [ ] Implement the shadow-mode flag + persistence of (features, shadow prediction,
      rule decision, outcome). **Queued behind E1** — `services/underwriting-service`
      is currently owned by the test-repair builder.
- [ ] Write the model card that `docs/ML_MODEL_STATUS.md` says does not exist.
- [ ] Define the promotion backtest: metrics, thresholds, sign-off owner.
- [ ] Open the conversation on sourcing real bureau performance data.
