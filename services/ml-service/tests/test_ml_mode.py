import os
from unittest.mock import patch
from ml_mode import (
    apply_ml_mode_override,
    get_ml_mode,
    ML_MODE_AUTO,
)


class TestMLMode:
    def test_default_is_auto(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ML_MODE", None)
            assert get_ml_mode() == ML_MODE_AUTO

    def test_invalid_mode_falls_back_to_auto(self):
        with patch.dict(os.environ, {"ML_MODE": "nonsense"}):
            assert get_ml_mode() == ML_MODE_AUTO

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
