"""
HTTP client for the softcredito-adapter internal service.

Calls /bureau/query to enrich the feature vector with a bureau score.
Gracefully degrades (returns neutral defaults) when the adapter is
unreachable or returns an error — underwriting still proceeds with
internal data only.
"""

import os
import httpx


SOFTCREDITO_URL = os.environ.get(
    "SOFTCREDITO_ADAPTER_URL",
    "http://vida-softcredito.railway.internal:3004",
)
INTERNAL_SECRET = os.environ.get("INTERNAL_SECRET", "")
BUREAU_TIMEOUT = 5.0  # seconds — fail fast so we don't block jobs


class SoftcreditoClient:
    async def query_bureau(self, *, curp_hash: str, full_name: str) -> dict:
        """
        Query the softcredito-adapter for a borrower's bureau score.

        Returns a dict with at least:
          { "riskScore": int, "found": bool }

        On any error returns the neutral default so the caller can
        gracefully degrade without crashing the job.
        """
        url = f"{SOFTCREDITO_URL}/bureau/query"
        headers = {
            "Content-Type": "application/json",
            "x-internal-secret": INTERNAL_SECRET,
        }
        payload = {"curpHash": curp_hash, "fullName": full_name}

        async with httpx.AsyncClient(timeout=BUREAU_TIMEOUT) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()
