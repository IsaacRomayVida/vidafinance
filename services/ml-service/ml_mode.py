"""ML_MODE env var handling — VID3-712.

Fail safe, not fail permissive. `auto` is the mode in which the model's raw
decision reaches the borrower with no human in the loop; `shadow` and
`manual_review_all` route every non-rejected decision to a human. So `auto` is
the *permissive* branch and it must never be reached by accident.

This module used to resolve BOTH an unset ML_MODE and an unrecognised one to
`auto`, which meant a single typo in the Railway variable —
`ML_MODE=manual_review-all`, `ML_MODE="manual_review_all"` with the quotes
kept, `ML_MODE=Manual Review All` — silently handed the models full decision
authority, with no error, no log line, and a /health response that still said
"ok". Config drift in the permissive direction is exactly the failure ADR-001
§Decision.4 forbids:

    "The gate is enforced in code, not convention. A single explicit flag
     controls ML authority, defaulting to shadow. It must not be flippable by
     config drift or an env var nobody reviews."

ADR-001 is ACCEPTED and says the default is shadow. So an absent or
unrecognised ML_MODE resolves to shadow, and `auto` is reachable only by
spelling it exactly. Tightening only: nothing that previously routed to a human
now auto-approves.
"""

import logging
import os

logger = logging.getLogger("ml_mode")

try:
    from prometheus_client import Counter

    _ml_mode_overrides = Counter(
        "ml_mode_overrides_total",
        "Number of times ML_MODE overrode the raw decision",
        ["mode", "original_decision"],
    )
except ImportError:
    _ml_mode_overrides = None

ML_MODE_AUTO = "auto"
ML_MODE_SHADOW = "shadow"
ML_MODE_MANUAL_REVIEW_ALL = "manual_review_all"

VALID_MODES = {ML_MODE_AUTO, ML_MODE_SHADOW, ML_MODE_MANUAL_REVIEW_ALL}

# The mode an absent or unreadable ML_MODE resolves to. Restrictive by
# construction: whatever goes wrong with the configuration, the answer is
# "a human looks at it", never "the model decides alone".
ML_MODE_FAIL_SAFE = ML_MODE_SHADOW


def get_ml_mode() -> str:
    """Return the current ML_MODE, resolving anything unrecognised to shadow.

    Unset and unrecognised are treated the same on purpose: both mean "nobody
    successfully told this process which mode to run in", and that is not a
    state in which the models get to decide loans on their own.
    """
    raw = os.environ.get("ML_MODE")
    if raw is None:
        return ML_MODE_FAIL_SAFE
    mode = raw.strip().lower()
    if mode in VALID_MODES:
        return mode
    logger.error(
        "ML_MODE=%r is not one of %s — falling back to %r. The ML models have "
        "NO decision authority until ML_MODE is spelled correctly (ADR-001).",
        raw,
        sorted(VALID_MODES),
        ML_MODE_FAIL_SAFE,
    )
    return ML_MODE_FAIL_SAFE


def apply_ml_mode_override(decision: str) -> str:
    """
    Apply ML_MODE override to a raw decision.

    - 'auto' (never the default — must be set explicitly): no-op, returns
      decision as-is
    - 'shadow': non-rejected decisions become 'manual_review' (ML score logged but not acted on)
    - 'manual_review_all': same as shadow — forces manual review on any non-rejected decision

    Hard 'rejected' decisions are NEVER overridden (hard business rules still apply).
    """
    mode = get_ml_mode()
    if mode == ML_MODE_AUTO:
        return decision
    if decision == "rejected":
        return decision
    # shadow and manual_review_all both route to manual review
    if mode in (ML_MODE_SHADOW, ML_MODE_MANUAL_REVIEW_ALL):
        if _ml_mode_overrides is not None:
            try:
                _ml_mode_overrides.labels(mode=mode, original_decision=decision).inc()
            except Exception:
                pass
        return "manual_review"
    return decision
