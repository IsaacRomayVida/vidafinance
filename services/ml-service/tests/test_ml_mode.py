import os
from unittest.mock import patch

import pytest

from ml_mode import (
    apply_ml_mode_override,
    get_ml_mode,
    ML_MODE_AUTO,
    ML_MODE_FAIL_SAFE,
)


class TestMLModeFailsSafe:
    """The two tests below previously asserted the opposite.

    They encoded `get_ml_mode()`'s original behaviour — unset OR unrecognised
    resolves to 'auto' — as if it were intended. It was the defect: 'auto' is
    the branch where the model's decision reaches the borrower with no human in
    the loop, so resolving *any* configuration failure to it means one typo in
    the Railway ML_MODE variable silently grants full decision authority.
    ADR-001 §Decision.4 ratifies the opposite ("defaulting to shadow ... must
    not be flippable by config drift"), so these now assert the fail-safe.
    """

    def test_unset_falls_back_to_restrictive_mode(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ML_MODE", None)
            assert get_ml_mode() == ML_MODE_FAIL_SAFE
            assert get_ml_mode() != ML_MODE_AUTO

    @pytest.mark.parametrize(
        "value",
        [
            "nonsense",
            "manual_review-all",  # hyphen instead of underscore
            '"manual_review_all"',  # quotes kept by the shell/CI
            "manual review all",  # spaces
            "AUTOMATIC",
            "",  # set-but-empty, e.g. `railway variables set ML_MODE=`
            "   ",
            "1",
            "true",
        ],
    )
    def test_unrecognised_value_never_resolves_to_auto(self, value):
        """A typo must not be an approval-authority grant."""
        with patch.dict(os.environ, {"ML_MODE": value}):
            assert get_ml_mode() == ML_MODE_FAIL_SAFE
            assert get_ml_mode() != ML_MODE_AUTO

    @pytest.mark.parametrize("value", ["nonsense", "manual_review-all", ""])
    def test_unrecognised_value_does_not_auto_approve(self, value):
        """The property that actually matters: no loan clears without a human."""
        with patch.dict(os.environ, {"ML_MODE": value}):
            assert apply_ml_mode_override("approved") == "manual_review"

    def test_unset_does_not_auto_approve(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ML_MODE", None)
            assert apply_ml_mode_override("approved") == "manual_review"

    def test_fail_safe_mode_is_itself_a_valid_restrictive_mode(self):
        """Guards against ML_MODE_FAIL_SAFE being repointed at 'auto' later."""
        assert ML_MODE_FAIL_SAFE != ML_MODE_AUTO
        with patch.dict(os.environ, {"ML_MODE": ML_MODE_FAIL_SAFE}):
            assert apply_ml_mode_override("approved") == "manual_review"
            assert apply_ml_mode_override("rejected") == "rejected"

    def test_auto_still_reachable_when_spelled_exactly(self):
        """The fail-safe must not make a deliberate, correct 'auto' unusable."""
        for spelling in ("auto", "AUTO", " auto "):
            with patch.dict(os.environ, {"ML_MODE": spelling}):
                assert get_ml_mode() == ML_MODE_AUTO
                assert apply_ml_mode_override("approved") == "approved"


class TestMLMode:
    def test_auto_preserves_approved(self):
        with patch.dict(os.environ, {"ML_MODE": "auto"}):
            assert apply_ml_mode_override("approved") == "approved"

    def test_auto_preserves_rejected(self):
        with patch.dict(os.environ, {"ML_MODE": "auto"}):
            assert apply_ml_mode_override("rejected") == "rejected"

    def test_manual_review_all_flips_approved(self):
        with patch.dict(os.environ, {"ML_MODE": "manual_review_all"}):
            assert apply_ml_mode_override("approved") == "manual_review"

    def test_manual_review_all_preserves_rejected(self):
        """Hard rejections (tenure, fraud) must still reject."""
        with patch.dict(os.environ, {"ML_MODE": "manual_review_all"}):
            assert apply_ml_mode_override("rejected") == "rejected"

    def test_shadow_flips_approved(self):
        with patch.dict(os.environ, {"ML_MODE": "shadow"}):
            assert apply_ml_mode_override("approved") == "manual_review"

    def test_manual_review_stays_manual_review(self):
        """Already-manual-review decisions stay the same."""
        with patch.dict(os.environ, {"ML_MODE": "manual_review_all"}):
            # apply_ml_mode_override maps non-rejected → manual_review; 'manual_review' input already fits
            result = apply_ml_mode_override("manual_review")
            assert result == "manual_review"
