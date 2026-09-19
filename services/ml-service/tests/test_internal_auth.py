"""
Regression tests for the internal-auth fail-open.

Before the fix, main.py read `SEC = os.environ.get("INTERNAL_SECRET", "")` with
no boot guard and compared with `if s != SEC`. With INTERNAL_SECRET unset, SEC
was "" and a request carrying an empty `x-internal-secret` header satisfied the
comparison — every scoring endpoint was callable by anyone.

TestAcceptedSecrets and TestPresentedSecretAccepted below cover the later
extension to an accepted SET (ML_INTERNAL_SECRET / INTERNAL_SECRET, plus their
`_ALT` counterparts) that mirrors services/shared/internal-secret.js and makes
a fleet rotation possible with no 401 window — see
docs/runbooks/rotate-internal-secret.md.
"""

import importlib
import os
import subprocess
import sys

import pytest

from internal_auth import (
    accepted_secrets,
    load_internal_secret,
    presented_secret_accepted,
    secret_matches,
)


class TestLoadInternalSecret:
    def test_missing_env_var_raises(self):
        with pytest.raises(RuntimeError, match="INTERNAL_SECRET is required"):
            load_internal_secret({})

    def test_empty_env_var_raises(self):
        with pytest.raises(RuntimeError, match="INTERNAL_SECRET is required"):
            load_internal_secret({"INTERNAL_SECRET": ""})

    def test_returns_configured_secret(self):
        assert load_internal_secret({"INTERNAL_SECRET": "s3cret"}) == "s3cret"

    def test_reads_os_environ_by_default(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SECRET", "from-environ")
        assert load_internal_secret() == "from-environ"

    def test_unset_os_environ_raises(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_SECRET", raising=False)
        with pytest.raises(RuntimeError, match="INTERNAL_SECRET is required"):
            load_internal_secret()

    def test_ml_internal_secret_wins_over_internal_secret(self):
        """Precedence: ML_INTERNAL_SECRET is ml-service's own secret and wins
        when both are set — see stage0-fraud.js's
        `ML_INTERNAL_SECRET || INTERNAL_SECRET`."""
        env = {"ML_INTERNAL_SECRET": "ml-secret", "INTERNAL_SECRET": "fleet-secret"}
        assert load_internal_secret(env) == "ml-secret"

    def test_falls_back_to_internal_secret_when_ml_unset(self):
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert load_internal_secret(env) == "fleet-secret"

    def test_alt_alone_does_not_satisfy_boot(self):
        """An `_ALT`-only configuration must not boot: it is not a valid
        steady state, only a mid-rotation accepted-but-never-sent value."""
        env = {"ML_INTERNAL_SECRET_ALT": "new", "INTERNAL_SECRET_ALT": "old"}
        with pytest.raises(RuntimeError, match="INTERNAL_SECRET is required"):
            load_internal_secret(env)


class TestSecretMatches:
    def test_correct_secret_matches(self):
        assert secret_matches("s3cret", "s3cret") is True

    def test_wrong_secret_rejected(self):
        assert secret_matches("s3cret", "nope") is False

    def test_missing_header_rejected(self):
        assert secret_matches("s3cret", None) is False

    def test_empty_header_rejected(self):
        assert secret_matches("s3cret", "") is False

    def test_empty_secret_never_matches(self):
        """The fail-open itself: "" == "" must NOT authenticate."""
        assert secret_matches("", "") is False
        assert secret_matches("", None) is False
        assert secret_matches(None, None) is False

    def test_different_lengths_rejected_without_raising(self):
        assert secret_matches("short", "a-much-longer-value") is False


class TestAcceptedSecrets:
    def test_only_primary_configured(self):
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert accepted_secrets(env) == ["fleet-secret"]

    def test_ml_and_fleet_both_configured(self):
        env = {"ML_INTERNAL_SECRET": "ml-secret", "INTERNAL_SECRET": "fleet-secret"}
        assert accepted_secrets(env) == ["ml-secret", "fleet-secret"]

    def test_alt_variants_included_when_set(self):
        env = {
            "ML_INTERNAL_SECRET": "ml-new",
            "INTERNAL_SECRET": "fleet-new",
            "ML_INTERNAL_SECRET_ALT": "ml-old",
            "INTERNAL_SECRET_ALT": "fleet-old",
        }
        assert accepted_secrets(env) == ["ml-new", "fleet-new", "ml-old", "fleet-old"]

    def test_unset_alt_is_dropped_not_treated_as_empty_string(self):
        """The most important correctness detail: an ALT that was never set
        must not appear in the accepted set at all, so it can never be the
        thing an empty presented secret matches against."""
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert "" not in accepted_secrets(env)

    def test_nothing_configured_yields_empty_set(self):
        assert accepted_secrets({}) == []


class TestPresentedSecretAccepted:
    def test_primary_secret_accepted(self):
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert presented_secret_accepted("fleet-secret", env) is True

    def test_ml_internal_secret_accepted(self):
        env = {"ML_INTERNAL_SECRET": "ml-secret", "INTERNAL_SECRET": "fleet-secret"}
        assert presented_secret_accepted("ml-secret", env) is True

    def test_alt_secret_accepted_during_rotation(self):
        """Step 2 of the runbook: primary already switched to `new`, ALT still
        holds `old` — a caller sending the not-yet-updated `old` value must
        still be accepted."""
        env = {"INTERNAL_SECRET": "new-secret", "INTERNAL_SECRET_ALT": "old-secret"}
        assert presented_secret_accepted("old-secret", env) is True
        assert presented_secret_accepted("new-secret", env) is True

    def test_wrong_secret_rejected(self):
        env = {"INTERNAL_SECRET": "fleet-secret", "INTERNAL_SECRET_ALT": "old-secret"}
        assert presented_secret_accepted("guess", env) is False

    def test_missing_presented_secret_rejected(self):
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert presented_secret_accepted(None, env) is False

    def test_empty_presented_secret_rejected(self):
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert presented_secret_accepted("", env) is False

    def test_unset_alt_never_lets_an_empty_presented_secret_through(self):
        """The fail-open this whole module exists to prevent, restated for
        the accepted set: with INTERNAL_SECRET_ALT never configured, an
        empty `x-internal-secret` header must not authenticate."""
        env = {"INTERNAL_SECRET": "fleet-secret"}
        assert presented_secret_accepted("", env) is False

    def test_nothing_configured_rejects_everything(self):
        """Fail closed even for the accepted-set path: no configured
        secrets means no presented value — including an empty one — is ever
        accepted."""
        assert presented_secret_accepted("", {}) is False
        assert presented_secret_accepted(None, {}) is False


# ── Boot + endpoint behaviour, exercised against the real app ──────────

SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)


TEST_SECRET = "the-real-secret"


def _boot_env(secret):
    """Env for a boot attempt: no Redis/Firebase, so lifespan starts no workers."""
    env = dict(os.environ)
    for var in (
        "REDIS_URL",
        "FIREBASE_SERVICE_ACCOUNT",
        "FIREBASE_SERVICE_ACCOUNT_B64",
    ):
        env.pop(var, None)
    # Resolve `main` explicitly rather than relying on the child's implicit
    # cwd entry, which other test modules in this suite can disturb.
    env["PYTHONPATH"] = os.pathsep.join(
        [SERVICE_ROOT] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    if secret is None:
        env.pop("INTERNAL_SECRET", None)
    else:
        env["INTERNAL_SECRET"] = secret
    return env


def _try_boot(secret):
    """Import main.py in a fresh interpreter — the real uvicorn startup path."""
    return subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=SERVICE_ROOT,
        env=_boot_env(secret),
        capture_output=True,
        text=True,
    )


class TestBootGuard:
    def test_unset_secret_aborts_boot(self):
        r = _try_boot(None)
        assert r.returncode != 0
        assert "INTERNAL_SECRET is required to start vida-ml-service" in r.stderr

    def test_empty_secret_aborts_boot(self):
        r = _try_boot("")
        assert r.returncode != 0
        assert "INTERNAL_SECRET is required to start vida-ml-service" in r.stderr

    def test_configured_secret_boots(self):
        r = _try_boot(TEST_SECRET)
        assert r.returncode == 0, r.stderr


@pytest.fixture(scope="module")
def client():
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    saved = {
        k: os.environ.get(k)
        for k in (
            "INTERNAL_SECRET",
            "REDIS_URL",
            "FIREBASE_SERVICE_ACCOUNT",
            "FIREBASE_SERVICE_ACCOUNT_B64",
        )
    }
    os.environ.update(_boot_env(TEST_SECRET))
    for var in (
        "REDIS_URL",
        "FIREBASE_SERVICE_ACCOUNT",
        "FIREBASE_SERVICE_ACCOUNT_B64",
    ):
        os.environ.pop(var, None)
    try:
        # Imported once per module: main.py registers Prometheus collectors at
        # module scope and a second import would collide in the default registry.
        main = importlib.import_module("main")
        # raise_server_exceptions=False: these tests assert on the auth gate
        # only. Handlers past it hit Redis/Firestore/model files that aren't
        # configured here, and those failures must surface as 5xx rather than
        # blowing up the request.
        with fastapi_testclient.TestClient(
            main.app, raise_server_exceptions=False
        ) as c:
            yield c
    finally:
        sys.modules.pop("main", None)
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# Every route in main.py that calls auth() — keep in sync with the @app
# decorators there.
GUARDED_ENDPOINTS = [
    ("post", "/underwrite/employer"),
    ("post", "/underwrite/employee"),
    ("get", "/explain/abc123"),
    ("post", "/monitor/drift"),
    ("get", "/monitor/drift/latest"),
    ("delete", "/cache/employer/uid123"),
    ("post", "/score"),
]


def _call(client, method, path, headers):
    if method == "post":
        return client.post(path, json={}, headers=headers)
    return getattr(client, method)(path, headers=headers)


@pytest.mark.parametrize("method,path", GUARDED_ENDPOINTS)
class TestEndpointAuth:
    def test_missing_header_is_401(self, client, method, path):
        assert _call(client, method, path, {}).status_code == 401

    def test_empty_header_is_401(self, client, method, path):
        r = _call(client, method, path, {"x-internal-secret": ""})
        assert r.status_code == 401

    def test_wrong_header_is_401(self, client, method, path):
        r = _call(client, method, path, {"x-internal-secret": "guess"})
        assert r.status_code == 401

    def test_correct_header_passes_auth(self, client, method, path):
        """Auth must not be the thing that stops a correctly-signed call."""
        r = _call(client, method, path, {"x-internal-secret": TEST_SECRET})
        assert r.status_code != 401
