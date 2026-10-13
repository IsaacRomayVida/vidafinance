"""
Internal service-to-service authentication for vida-ml-service.

Fail closed: every internal endpoint compares the `x-internal-secret` request
header against an accepted SET of secrets rather than a single value. When
nothing is configured the accepted set is empty, and a caller sending an empty
`x-internal-secret` header must never match it — which opens
/underwrite/employer, /underwrite/employee, /explain/{decision_id}, /drift and
/clear_cache/{uid} to anyone. Refuse to boot rather than serve scoring
unauthenticated.

Same pattern as vida-underwriting-service and vida-registry-service, which do
this with a module-scope `throw` in index.js.

Why a SET and not a value
--------------------------
`services/shared/internal-secret.js` documents the problem this solves for the
Node services: rotating a single shared secret across every caller and callee
cannot be atomic, so for the length of the rollout some caller still sends the
old value while some callee already expects only the new one — a 401 in the
middle of a live loan flow. ml-service has its own secret,
`ML_INTERNAL_SECRET` (docs/runbooks/rotate-internal-secret.md), with
`INTERNAL_SECRET` accepted as the fleet-wide fallback — this mirrors what
services/underwriting-service/src/stages/stage0-fraud.js sends:
`ML_INTERNAL_SECRET || INTERNAL_SECRET`. Each of those two also has an `_ALT`
counterpart that is accepted but never sent, which turns a rotation into three
ordered steps with no 401 window at any point:

  1. set *_ALT = new                 — everyone accepts {old, new}, sends old
  2. set primary = new, *_ALT = old  — still accepting both, now sending new
  3. clear *_ALT                     — only the new value is accepted or sent
"""

import hashlib
import hmac
import os

# Primary variables, in send-preference order: a caller that has its own
# ML_INTERNAL_SECRET sends that; everything else falls back to the fleet-wide
# INTERNAL_SECRET. Do not reorder this — it is the precedence load_internal_secret
# and accepted_secrets both rely on.
_PRIMARY_VARS = ("ML_INTERNAL_SECRET", "INTERNAL_SECRET")
_ALT_VARS = ("ML_INTERNAL_SECRET_ALT", "INTERNAL_SECRET_ALT")


def _read(source, name):
    """Look up `name` in `source`, treating anything falsy/non-string as unset."""
    value = source.get(name, "") or ""
    return value if isinstance(value, str) else ""


def load_internal_secret(env=None):
    """Return the configured primary secret, raising when none is set.

    `ML_INTERNAL_SECRET` wins over `INTERNAL_SECRET` when both are set — see
    the module docstring. This is the boot guard: called at module scope in
    main.py so a deploy with neither variable set aborts process start
    instead of silently degrading to an open service. It intentionally does
    not consider either `_ALT` variable — an `_ALT`-only configuration (the
    end state of a rotation's step 3, run backwards) is not a valid steady
    state and must not let the service boot.
    """
    source = os.environ if env is None else env
    secret = _read(source, "ML_INTERNAL_SECRET") or _read(source, "INTERNAL_SECRET")
    if not secret:
        raise RuntimeError("INTERNAL_SECRET is required to start vida-ml-service")
    return secret


def accepted_secrets(env=None):
    """The values a verifier accepts right now, in send-preference order.

    Empty/unset candidates are dropped here, before any comparison happens:
    an unset `_ALT` variable must never be able to authenticate an empty
    presented secret, which is why this filters on truthiness rather than
    letting `secret_matches` do it alone.
    """
    source = os.environ if env is None else env
    names = _PRIMARY_VARS + _ALT_VARS
    return [value for value in (_read(source, name) for name in names) if value]


def secret_matches(secret, presented):
    """Constant-time compare of a header against one candidate secret.

    Both sides must be non-empty strings: a missing header (None) or an empty
    one never matches, even if `secret` were somehow empty too. Both sides are
    hashed to a fixed-width digest before comparison — `hmac.compare_digest`
    is only documented to run in constant time when its two inputs are the
    same length, and the presented header's length is entirely the caller's.
    """
    if not isinstance(secret, str) or not isinstance(presented, str):
        return False
    if not secret or not presented:
        return False
    a = hashlib.sha256(secret.encode("utf-8")).digest()
    b = hashlib.sha256(presented.encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def presented_secret_accepted(presented, env=None):
    """Does the presented header match any secret in the accepted set?

    Every candidate is checked even after one matches — an early return would
    make "matched the first candidate" and "matched a later one" take
    measurably different amounts of time, exactly what the constant-time
    compare in `secret_matches` exists to avoid.
    """
    accepted = False
    for secret in accepted_secrets(env):
        accepted = secret_matches(secret, presented) or accepted
    return accepted
