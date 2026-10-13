# Load test — emulator (smoke)

```

╔══════════════════════════════════════════════════════════════════════╗
║           VIDA Load Test — Performance Report                       ║
╚══════════════════════════════════════════════════════════════════════╝
  TARGET: EMULATOR  http://127.0.0.1:5041/demo-vida-load/us-central1
  Profile: smoke   Finished: 2026-10-13T14:07:25.432Z

┌─ End-to-End Latency ─────────────────────────────────────────────┐
│  P50:  61ms
│  P90:  104ms
│  P95:  115ms
│  P99:  2206ms
│  Max:  2286ms
│  Avg:  112ms
└──────────────────────────────────────────────────────────────────┘

┌─ Throughput ──────────────────────────────────────────────────────┐
│  Total submitted: 90
│  Succeeded:       90
│  Failed:          0
│  Error rate:      0.00%
└──────────────────────────────────────────────────────────────────┘

┌─ Error Breakdown ────────────────────────────────────────────────┐
│  Rate limited (429):   0
│  Timeouts:             0
│  Server errors (5xx):  0
│  Unauthenticated (401): 0   (App Check or sign-in)
│  Refused (FAILED_PRECONDITION): 0   (open loan already / business rule)
│  Refused (INVALID_ARGUMENT):    0   (amount over the credit left — a reused member)
│  Other:                0
│  Pool sign-in failures: 0
└──────────────────────────────────────────────────────────────────┘

┌─ Per-Stage Latency (P95) ────────────────────────────────────────┐
│  not instrumented — the target sends no X-Stage-*-Ms headers,
│  so only the end-to-end latency above was measured
└──────────────────────────────────────────────────────────────────┘

┌─ Profile Distribution ───────────────────────────────────────────┐
│  Good:   45
│  Medium: 27
│  Risky:  18
└──────────────────────────────────────────────────────────────────┘

┌─ Acceptance Criteria ────────────────────────────────────────────┐
│  P95 < 30s:                 ✓ PASS  (0.1s)  — at smoke load, not at the target rate
│  Error rate < 1%:           ✓ PASS  (0.00%)
│  2x target without errors:  N/A  (the smoke profile does not reach it)
│  EMULATOR run: this proves the script and the seeded pool work.
│  The latencies are this machine's, not the platform's; it closes nothing.
└──────────────────────────────────────────────────────────────────┘

```
