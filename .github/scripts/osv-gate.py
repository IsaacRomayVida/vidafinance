#!/usr/bin/env python3
# © Suena AG / FunPay Technologies. All rights reserved.
"""Fail when an OSV-Scanner JSON report holds a CRITICAL or HIGH vulnerability.

osv-scanner has no severity threshold flag, so the gate lives here. A group
(one advisory plus its aliases) counts as blocking when its CVSS score is 7.0
or higher, or, when no score is present, when any member advisory carries a
database_specific.severity of HIGH or CRITICAL (GitHub advisories do).

Usage: osv-gate.py report.json
Exit 0 = nothing blocking, 1 = blocking findings, 2 = unreadable report.
"""
import json
import sys

THRESHOLD = 7.0
BLOCKING_LABELS = {"HIGH", "CRITICAL"}


def main() -> int:
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            report = json.load(fh)
    except (OSError, ValueError, IndexError) as err:
        print(f"::error::cannot read OSV report: {err}")
        return 2

    blocking = []
    for result in report.get("results") or []:
        source = (result.get("source") or {}).get("path", "?")
        for pkg in result.get("packages") or []:
            info = pkg.get("package") or {}
            label = f"{info.get('name', '?')}@{info.get('version', '?')}"
            vulns = {v.get("id"): v for v in pkg.get("vulnerabilities") or []}
            for group in pkg.get("groups") or []:
                ids = group.get("ids") or []
                try:
                    score = float(group.get("max_severity", ""))
                except (TypeError, ValueError):
                    score = None
                labels = {
                    str((vulns.get(i, {}).get("database_specific") or {}).get("severity", "")).upper()
                    for i in ids
                }
                if (score is not None and score >= THRESHOLD) or (
                    score is None and labels & BLOCKING_LABELS
                ):
                    blocking.append((source, label, ids, score))

    if not blocking:
        print("OSV: no critical or high vulnerabilities.")
        return 0

    print(f"OSV: {len(blocking)} critical/high finding(s)")
    for source, label, ids, score in blocking:
        shown = f"CVSS {score}" if score is not None else "severity label"
        print(f"::error title=OSV {', '.join(ids[:2])}::{label} in {source} ({shown})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
