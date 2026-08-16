# Offline ML experiment pipeline

`services/ml-service/pipelines/ml_experiment.py` is a bounded Dagster-compatible
experiment for deterministic reference data, feature validation, champion and
challenger training, holdout evaluation, PSI drift reporting, an explicit
approval gate, and candidate artifact export.

It is intentionally separate from the live underwriting path. The exported
manifest records `authority: shadow_only`; no endpoint or worker reads these
artifacts. Approval requires champion AUC >= 0.60 and maximum feature PSI <=
0.25. A failed gate still exports evidence, but the candidate must not be
promoted. Install the development orchestration dependency and run the job with
Dagster in an offline environment; alternatively call `run_experiment()` in a
test or controlled script.

The reference dataset is synthetic and is not evidence for lending decisions.
Promotion still requires real repayment outcomes and the sign-off specified by
[ADR-001](../adr/ADR-001-ml-shadow-mode-gate.md).
