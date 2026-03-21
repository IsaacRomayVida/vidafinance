"""
Async-friendly Firestore wrapper using the firebase-admin SDK.

Credentials are loaded from (in priority order):
  1. FIREBASE_SERVICE_ACCOUNT_B64 — base64-encoded service account JSON
  2. FIREBASE_SERVICE_ACCOUNT     — raw JSON string

Both patterns match the existing Node.js services in this repo.
"""

import base64
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore as fs


def _init_firebase():
    """Initialize firebase-admin app once per process."""
    if firebase_admin._DEFAULT_APP_NAME in firebase_admin._apps:
        return

    b64 = os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64")
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")

    if not b64 and not raw:
        raise RuntimeError(
            "Firebase credentials missing: set FIREBASE_SERVICE_ACCOUNT or "
            "FIREBASE_SERVICE_ACCOUNT_B64"
        )

    if b64:
        raw = base64.b64decode(b64).decode("utf-8")

    cert = credentials.Certificate(json.loads(raw))
    firebase_admin.initialize_app(cert)


class FirestoreClient:
    """Thin synchronous wrapper around the Firestore Admin SDK.

    Methods are synchronous (firebase-admin's Firestore client is blocking).
    Call from a thread pool executor if needed inside async contexts.
    """

    def __init__(self):
        _init_firebase()
        self._db = fs.client()

    def update_loan(self, loan_id: str, data: dict):
        """Update a loan document with the given fields."""
        self._db.collection("loans").document(loan_id).update(data)

    def get_loan(self, loan_id: str):
        doc = self._db.collection("loans").document(loan_id).get()
        return doc.to_dict() if doc.exists else None

    @staticmethod
    def array_union(item: dict):
        """Convenience wrapper for Firestore ArrayUnion."""
        return fs.ArrayUnion([item])
