"""
Shared test configuration.

Mocks external dependencies that require Python 3.10+ or live credentials
so tests can run on Python 3.9.
"""

import sys
from unittest.mock import MagicMock

# bullmq uses Python 3.10+ type union syntax (dict | str)
sys.modules.setdefault("bullmq", MagicMock())

# Firebase/Firestore requires credentials
if "services.firestore_client" not in sys.modules:
    _mock_fc = MagicMock()
    _mock_fc.FirestoreClient = MagicMock
    sys.modules["services.firestore_client"] = _mock_fc

# SoftCrédito client requires network access
if "services.softcredito_client" not in sys.modules:
    _mock_sc = MagicMock()
    _mock_sc.SoftcreditoClient = MagicMock
    sys.modules["services.softcredito_client"] = _mock_sc
