"""Regression tests for /score's input contract and output range check.

Two defects, both audited on branch audit/ml-service-registry:

1. /score read `borrowerSnapshot` / `principalAmount` / `monthlySalary` with
   silent defaults ({} / 0 / 1). The live caller
   (services/underwriting-service/src/stages/stage2-bureau.js:310) sends a FLAT
   feature dict and carries none of those keys, so every request in production
   scored the same phantom applicant. Measured against the shipped champion
   artifact: championScore = 0.0316 for every applicant regardless of input,
   i.e. a fabricated P(default) of 0.9684 on 100% of loans.

2. Model output was never range-checked. `deriveDefaultProbability`
   (stage3-autoapprove.js:102) computes `1 - championScore` with no clamp, so a
   championScore above 1 yields a NEGATIVE P(default) that clears every cutoff —
   a bad model artifact alone auto-approves everyone.

These tests exercise the pure helpers rather than the endpoint so they need no
Redis, no Firestore, no model files, and no TestClient — the same reason
tests/test_internal_auth.py splits its unit assertions from its client
fixtures.

They import `score_contract`, never `main`, deliberately. main.py binds
INTERNAL_SECRET into a module-level `SEC` at import time, so a test module that
imports it during collection pins that value in sys.modules and
tests/test_internal_auth.py's client fixture — which re-imports main under a
different secret — then authenticates against the stale one and every
`test_correct_header_passes_auth` case fails with a 401. That is an import-order
coupling, not a real defect, and the split avoids it entirely.
"""

import pytest
from fastapi import HTTPException

from score_contract import assert_scores_in_range, read_scoreable_payload


# The exact body services/underwriting-service/src/stages/stage2-bureau.js:310
# builds and POSTs to /score today. Copied field-for-field; if that call site
# ever changes shape, this constant is what has to change with it.
LIVE_STAGE2_PAYLOAD = {
    "employment_tenure_months": 120,
    "monthly_salary": 45000.0,
    "pay_frequency_encoded": 2,
    "loan_to_salary_ratio": 0.1,
    "employer_industry_encoded": 4,
    "principal_amount": 4500,
    "bureau_score": 780,
    "has_bureau_record": 1,
}

VALID_PAYLOAD = {
    "principalAmount": 4500,
    "borrowerSnapshot": {
        "monthlySalary": 45000.0,
        "employmentTenureMonths": 120,
        "riskSealScore": 85,
        "employerTier": 1,
    },
}


class TestRefusesPayloadsItCannotActuallyScore:
    def test_live_stage2_payload_is_refused_not_silently_defaulted(self):
        """The defect itself: this payload used to score a phantom applicant."""
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(LIVE_STAGE2_PAYLOAD)
        assert exc.value.status_code == 422

    def test_empty_payload_is_refused(self):
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload({})
        assert exc.value.status_code == 422

    @pytest.mark.parametrize("bad", [None, [], "string", 7])
    def test_non_object_payload_is_refused(self, bad):
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(bad)
        assert exc.value.status_code == 422

    @pytest.mark.parametrize("bad", [None, {}, [], "x", 0])
    def test_missing_or_empty_borrower_snapshot_is_refused(self, bad):
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload({"principalAmount": 4500, "borrowerSnapshot": bad})
        assert exc.value.status_code == 422

    @pytest.mark.parametrize(
        "field", ["monthlySalary", "employmentTenureMonths"]
    )
    def test_missing_required_borrower_field_is_refused(self, field):
        borrower = dict(VALID_PAYLOAD["borrowerSnapshot"])
        borrower.pop(field)
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"principalAmount": 4500, "borrowerSnapshot": borrower}
            )
        assert exc.value.status_code == 422
        assert field in exc.value.detail

    def test_missing_principal_amount_is_refused(self):
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"borrowerSnapshot": VALID_PAYLOAD["borrowerSnapshot"]}
            )
        assert exc.value.status_code == 422

    @pytest.mark.parametrize(
        "value",
        [0, -1, -0.01, float("nan"), float("inf"), float("-inf"), "abc", None, True, []],
    )
    def test_non_positive_or_unparseable_principal_is_refused(self, value):
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {
                    "principalAmount": value,
                    "borrowerSnapshot": VALID_PAYLOAD["borrowerSnapshot"],
                }
            )
        assert exc.value.status_code == 422

    @pytest.mark.parametrize(
        "value", [0, -5000, float("nan"), float("inf"), "abc", None, True]
    )
    def test_non_positive_salary_is_refused(self, value):
        """A zero salary used to become `max(salary, 1)` = 1, making LTI absurd."""
        borrower = dict(VALID_PAYLOAD["borrowerSnapshot"], monthlySalary=value)
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"principalAmount": 4500, "borrowerSnapshot": borrower}
            )
        assert exc.value.status_code == 422

    @pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), "abc", None])
    def test_invalid_tenure_is_refused(self, value):
        borrower = dict(
            VALID_PAYLOAD["borrowerSnapshot"], employmentTenureMonths=value
        )
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"principalAmount": 4500, "borrowerSnapshot": borrower}
            )
        assert exc.value.status_code == 422

    def test_no_payload_value_is_echoed_into_the_error(self):
        """Errors are logged by the caller; salary and principal are PII.

        The rejected values below are deliberately malformed *and* carry the
        kind of content that must not reach a log line — a real salary figure
        and a CURP — so a future `f"{path}={value}"` style message fails here.
        """
        borrower = dict(
            VALID_PAYLOAD["borrowerSnapshot"], monthlySalary="41234.99 MXN"
        )
        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"principalAmount": "GOMC960212HDFXXX09", "borrowerSnapshot": borrower}
            )
        assert "41234.99" not in exc.value.detail
        assert "GOMC960212HDFXXX09" not in exc.value.detail

        with pytest.raises(HTTPException) as exc:
            read_scoreable_payload(
                {"principalAmount": -41234.99, "borrowerSnapshot": borrower}
            )
        assert "41234.99" not in exc.value.detail


class TestAcceptsWhatItCanActuallyScore:
    def test_valid_payload_returns_parsed_inputs(self):
        borrower, principal, salary = read_scoreable_payload(VALID_PAYLOAD)
        assert borrower is VALID_PAYLOAD["borrowerSnapshot"]
        assert principal == 4500.0
        assert salary == 45000.0

    def test_numeric_strings_are_accepted(self):
        borrower = dict(VALID_PAYLOAD["borrowerSnapshot"], monthlySalary="45000")
        _, principal, salary = read_scoreable_payload(
            {"principalAmount": "4500", "borrowerSnapshot": borrower}
        )
        assert (principal, salary) == (4500.0, 45000.0)

    def test_zero_tenure_is_allowed_and_falls_to_the_hard_reject_rule(self):
        """Zero tenure is a real applicant state; absent tenure is not."""
        borrower = dict(VALID_PAYLOAD["borrowerSnapshot"], employmentTenureMonths=0)
        borrower_out, _, _ = read_scoreable_payload(
            {"principalAmount": 4500, "borrowerSnapshot": borrower}
        )
        assert borrower_out["employmentTenureMonths"] == 0


class TestScoreRangeCheck:
    @pytest.mark.parametrize("score", [0.0, 0.0316, 0.5, 0.9636, 1.0])
    def test_probabilities_in_range_are_served(self, score):
        assert assert_scores_in_range(score, score) is None

    @pytest.mark.parametrize(
        "champion",
        [
            1.0001,
            1.4,  # -> P(default) = -0.4 downstream: clears EVERY cutoff
            100.0,  # a 0-100 scorecard mistaken for a probability
            -0.1,
            float("nan"),
            float("inf"),
            float("-inf"),
        ],
    )
    def test_out_of_range_champion_is_refused_not_served(self, champion):
        with pytest.raises(HTTPException) as exc:
            assert_scores_in_range(champion, 0.5)
        assert exc.value.status_code == 503

    @pytest.mark.parametrize("challenger", [1.5, -2.0, float("nan")])
    def test_out_of_range_challenger_is_refused(self, challenger):
        with pytest.raises(HTTPException) as exc:
            assert_scores_in_range(0.5, challenger)
        assert exc.value.status_code == 503

    @pytest.mark.parametrize("bad", ["0.9", None, True, [0.9]])
    def test_non_numeric_score_is_refused(self, bad):
        with pytest.raises(HTTPException) as exc:
            assert_scores_in_range(bad, 0.5)
        assert exc.value.status_code == 503


def test_out_of_range_score_would_otherwise_invert_the_downstream_gate():
    """Documents WHY the range check is a 503 and not a clamp.

    Mirrors stage3-autoapprove.js:102 `1 - championScore` against the 0.15
    cutoff from config/maxPDefaultCutoff.js. A clamp would silently turn a
    broken artifact into a plausible score; a 503 routes to manual review.
    """
    MAX_PDEFAULT = 0.15
    broken_champion = 1.4
    p_default = 1 - broken_champion
    assert p_default < MAX_PDEFAULT, "premise: an out-of-range score clears the gate"

    with pytest.raises(HTTPException):
        assert_scores_in_range(broken_champion, 0.5)
