"""
Test conftest — mock modules that require Python 3.10+ syntax when running
on older interpreters (e.g. bullmq uses `dict | str` union types).
"""

import sys
from unittest.mock import MagicMock

# bullmq requires Python 3.10+ due to PEP 604 type unions in its source.
# Mock it so tests can run on 3.9 (the system Python on macOS).
if sys.version_info < (3, 10):
    bullmq_mock = MagicMock()
    sys.modules.setdefault("bullmq", bullmq_mock)
