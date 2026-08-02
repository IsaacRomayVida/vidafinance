"""
Regression tests for the internal-auth fail-open.

Before the fix, main.py read `SEC = os.environ.get("INTERNAL_SECRET", "")` with
no boot guard and compared with `if s != SEC`. With INTERNAL_SECRET unset, SEC
was "" and a request carrying an empty `x-internal-secret` header satisfied the
comparison — every scoring endpoint was callable by anyone.
"""

import importlib
import os
import subprocess
import sys

import pytest

from internal_auth import load_internal_secret, secret_matches


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
