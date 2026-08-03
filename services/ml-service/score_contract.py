"""Input contract and output range check for the /score endpoint.

Split out of main.py for the same reason internal_auth.py and ml_mode.py are:
these are pure functions with no Redis, Firestore, model-file or app state
dependency, so they can be tested directly without importing main (which binds
INTERNAL_SECRET at module scope and registers Prometheus collectors).

Both defects this module closes are documented on the functions below.
"""

from fastapi import HTTPException

# Fields /score cannot invent a default for without fabricating an applicant.
# Each one feeds a value that decides the outcome:
#   principalAmount              -> lti = principal / salary
#   monthlySalary                -> lti denominator
#   employmentTenureMonths       -> the `< 3` hard rejection rule below
# Every other field build_model_features() reads has a population-level default
# that is at worst imprecise; these three make the answer meaningless.
_REQUIRED_BORROWER_FIELDS = ("monthlySalary", "employmentTenureMonths")


def _read_positive_number(container, key, path):
    """Return `container[key]` as a finite positive float, or raise 422.

    Only the field *path* ever reaches the error string — never the value.
    Payload values here are borrower PII (salary, principal) and the response
    is logged by the caller on failure.
    """
    if not isinstance(container, dict) or key not in container:
        raise HTTPException(422, f"{path} is required")
    raw = container[key]
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        raise HTTPException(422, f"{path} must be a number")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise HTTPException(422, f"{path} must be a number")
    if value != value or value in (float("inf"), float("-inf")):
        raise HTTPException(422, f"{path} must be a finite number")
    if value <= 0:
        raise HTTPException(422, f"{path} must be greater than zero")
    return value


def read_scoreable_payload(payload):
    """Extract (borrower, principal, monthly_salary) or refuse with a 422.

    ── Why this exists ───────────────────────────────────────────────────────
    This endpoint used to read its inputs with silent defaults:

        borrower       = payload.get("borrowerSnapshot", {})
        principal      = float(payload.get("principalAmount", 0))
        monthly_salary = float(borrower.get("monthlySalary", 1))

    The live caller — services/underwriting-service/src/stages/stage2-bureau.js
    :310 — sends a FLAT feature dict (`monthly_salary`, `principal_amount`,
    `employment_tenure_months`, ...), not `borrowerSnapshot`/`principalAmount`.
    None of the three lookups above hit anything, so every request collapsed to
    the same phantom applicant: principal 0, salary 1, tenure 0, and the
    population defaults in build_model_features() for everything else.

    Measured against the shipped champion artifact, that phantom scores a
    constant championScore = 0.0316 for EVERY applicant — a prime borrower on
    120 months tenure and a subprime borrower on 1 month produce byte-identical
    feature vectors. Stage 3 condition 8 reads that as P(default) = 0.9684
    (stage3-autoapprove.js:102 `1 - championScore`) against a 0.15 cutoff, so
    the condition failed for 100% of applicants — the exact defect the comment
    at stage3-autoapprove.js:313 says was already fixed on the reading side,
    still live on the producing side.

    ── Why refuse rather than start reading the flat shape ───────────────────
    Teaching /score the flat shape would turn a constant 0.9684 into real
    P(default) values, which would let applicants clear condition 8 that cannot
    clear it today. That is a loosening of the auto-approve gate and a change to
    a lending decision boundary — it needs a human ruling and a ratified
    contract, not an audit fix. Reconciling the two payload shapes is tracked
    separately; this module only stops the fabricated score.

    Refusing is decision-equivalent and strictly more honest. The caller wraps
    this in try/catch and records `{skipped: true}` (stage2-bureau.js:323), so
    `provenanceOf` yields "assumed" and condition 8 fails on `source !== "read"`
    — the same failure, now for the true reason ("no ML score was read") instead
    of a fabricated 96.84% default probability persisted on the loan and shown
    to ops as why the decision went the way it did.
    """
    if not isinstance(payload, dict):
        raise HTTPException(422, "payload must be an object")

    borrower = payload.get("borrowerSnapshot")
    if not isinstance(borrower, dict) or not borrower:
        raise HTTPException(
            422,
            "borrowerSnapshot is required and must be a non-empty object; "
            "refusing to score an applicant whose attributes were not supplied",
        )

    missing = [f for f in _REQUIRED_BORROWER_FIELDS if f not in borrower]
    if missing:
        raise HTTPException(
            422,
            "borrowerSnapshot is missing required field(s): "
            + ", ".join(sorted(missing)),
        )

    principal = _read_positive_number(payload, "principalAmount", "principalAmount")
    monthly_salary = _read_positive_number(
        borrower, "monthlySalary", "borrowerSnapshot.monthlySalary"
    )
    # Tenure is the one required field allowed to be zero — a borrower genuinely
    # can have zero months of tenure, and the `< 3` rule below rejects them for
    # it. What is not allowed is tenure being *absent*, because then that
    # rejection reason describes a field nobody ever sent.
    tenure = borrower["employmentTenureMonths"]
    if isinstance(tenure, bool) or not isinstance(tenure, (int, float, str)):
        raise HTTPException(
            422, "borrowerSnapshot.employmentTenureMonths must be a number"
        )
    try:
        tenure = float(tenure)
    except (TypeError, ValueError):
        raise HTTPException(
            422, "borrowerSnapshot.employmentTenureMonths must be a number"
        )
    if tenure != tenure or tenure in (float("inf"), float("-inf")) or tenure < 0:
        raise HTTPException(
            422,
            "borrowerSnapshot.employmentTenureMonths must be a finite, non-negative number",
        )

    return borrower, principal, monthly_salary


def assert_scores_in_range(champion_score, challenger_score):
    """Refuse to serve a probability that is not one.

    The models are unpickled joblib artifacts (`ModelRouter.load`), so their
    output range is a property of whatever file is on disk, not of this code. A
    swapped, re-trained, or half-converted artifact that returns a raw logit or
    a 0-100 score instead of a probability does not fail loudly anywhere: it
    just returns a number.

    Downstream, `deriveDefaultProbability` (stage3-autoapprove.js:102) accepts
    any finite number and computes `1 - championScore` with no clamp. A
    championScore of 1.4 becomes P(default) = -0.4, which is below EVERY
    possible cutoff — condition 8 would pass for every applicant, and the worse
    the out-of-range score the more certainly it passes. That is an
    auto-approve-everyone failure produced by a bad model file alone.

    So a score outside [0, 1] is treated as a service fault (503), not as a
    lending decision. Failing the request routes the applicant to manual review
    via the caller's existing skip path; emitting the number does not.
    """
    for name, score in (
        ("championScore", champion_score),
        ("challengerScore", challenger_score),
    ):
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            raise HTTPException(503, f"model returned a non-numeric {name}")
        if score != score or score in (float("inf"), float("-inf")):
            raise HTTPException(503, f"model returned a non-finite {name}")
        if not (0.0 <= float(score) <= 1.0):
            raise HTTPException(
                503,
                f"model returned {name} outside [0, 1]; refusing to serve it as "
                "a probability",
            )
