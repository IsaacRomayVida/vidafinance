"""
Internal service-to-service authentication for vida-ml-service.

Fail closed: every internal endpoint compares the `x-internal-secret` request
header against INTERNAL_SECRET. When that variable is unset the configured
secret is the empty string, and a caller sending an empty `x-internal-secret`
header matches it — which opens /underwrite/employer, /underwrite/employee,
/explain/{decision_id}, /drift and /clear_cache/{uid} to anyone. Refuse to boot
rather than serve scoring unauthenticated.

Same pattern as vida-underwriting-service and vida-registry-service, which do
this with a module-scope `throw` in index.js.
"""

import hmac
import os


def load_internal_secret(env=None):
    """Return INTERNAL_SECRET, raising at import time when it is missing.

    Called at module scope in main.py so an unset secret aborts process start
    instead of silently degrading to an open service.
    """
    source = os.environ if env is None else env
    secret = source.get("INTERNAL_SECRET", "") or ""
    if not secret:
        raise RuntimeError("INTERNAL_SECRET is required to start vida-ml-service")
    return secret


def secret_matches(secret, presented):
    """Constant-time compare of a header against the configured secret.

    Both sides must be non-empty: a missing header (None) or an empty one never
    matches, even if `secret` were somehow empty too.
    """
    if not secret or not presented:
        return False
    return hmac.compare_digest(str(secret), str(presented))
