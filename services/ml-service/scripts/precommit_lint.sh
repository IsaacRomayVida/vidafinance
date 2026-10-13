#!/usr/bin/env bash
# Runs one tool of the ml-service black+flake8 pre-commit gate the way CI
# does: from inside services/ml-service, so setup.cfg (max-line-length,
# extend-ignore, per-file-ignores) is actually read. lint-staged used to
# invoke these from the repo root with absolute file paths, which silently
# dropped that config and failed unmodified, CI-green files on flake8's
# 79-column default (#474).
#
# lint-staged appends the staged file paths as extra arguments after $1;
# they land in $2.. below and are intentionally unused — matching-CI means
# linting the whole service, not just the staged files.
#
# Also guards the other half of #474: black/flake8 are pinned in
# requirements-dev.txt but nothing installs them for the hook, so a
# contributor without both on PATH got a bare "No module named black"
# ImportError and reached for --no-verify. Fail loudly and specifically
# instead of falling through to a skipped gate.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tool="${1:?usage: precommit_lint.sh <black|flake8>}"

# Prefer this service's own virtualenv over whatever python3 is on PATH.
# The toolchain is pinned in requirements-dev.txt and installed into .venv
# by the documented setup (uv), but `python3` at the repo root resolves to
# the system interpreter, which does not have it. That produced the exact
# failure this script was written to prevent: a contributor with a
# correctly provisioned .venv is told the toolchain is missing, and
# reaches for --no-verify. Look where it actually lives first.
PY=python3
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
fi

if ! "$PY" -m "$tool" --version >/dev/null 2>&1; then
  echo "error: $PY -m $tool is not installed (needed by the ml-service pre-commit lint gate)." >&2
  echo "Install the pinned lint toolchain: pip install -r services/ml-service/requirements-dev.txt" >&2
  echo "(or provision the service virtualenv: cd services/ml-service && uv sync)" >&2
  exit 1
fi

case "$tool" in
  black) exec "$PY" -m black --check . ;;
  flake8) exec "$PY" -m flake8 ;;
  *)
    echo "error: precommit_lint.sh does not know tool '$tool'" >&2
    exit 1
    ;;
esac
