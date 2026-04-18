"""ML_MODE env var handling — VID3-712."""
import os
from typing import Literal
try:
    from prometheus_client import Counter
    _ml_mode_overrides = Counter(
        'ml_mode_overrides_total',
        'Number of times ML_MODE overrode the raw decision',
        ['mode', 'original_decision'],
    )
except ImportError:
    _ml_mode_overrides = None

ML_MODE_AUTO = 'auto'
ML_MODE_SHADOW = 'shadow'
ML_MODE_MANUAL_REVIEW_ALL = 'manual_review_all'

VALID_MODES = {ML_MODE_AUTO, ML_MODE_SHADOW, ML_MODE_MANUAL_REVIEW_ALL}


def get_ml_mode() -> str:
    """Returns the current ML_MODE. Defaults to 'auto' if unset/invalid."""
    mode = os.environ.get('ML_MODE', ML_MODE_AUTO).strip().lower()
    if mode not in VALID_MODES:
        return ML_MODE_AUTO
    return mode


def apply_ml_mode_override(decision: str) -> str:
    """
    Apply ML_MODE override to a raw decision.

    - 'auto' (default): no-op, returns decision as-is
    - 'shadow': non-rejected decisions become 'manual_review' (ML score logged but not acted on)
    - 'manual_review_all': same as shadow — forces manual review on any non-rejected decision

    Hard 'rejected' decisions are NEVER overridden (hard business rules still apply).
    """
    mode = get_ml_mode()
    if mode == ML_MODE_AUTO:
        return decision
    if decision == 'rejected':
        return decision
    # shadow and manual_review_all both route to manual review
    if mode in (ML_MODE_SHADOW, ML_MODE_MANUAL_REVIEW_ALL):
        if _ml_mode_overrides is not None:
            try:
                _ml_mode_overrides.labels(mode=mode, original_decision=decision).inc()
            except Exception:
                pass
        return 'manual_review'
    return decision
