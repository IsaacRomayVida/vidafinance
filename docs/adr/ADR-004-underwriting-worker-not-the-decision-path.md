# ADR-004 — Retire the 11 decision-engine tests in `underwriting_worker`; do not implement `call_decision_engine`

- **Status:** ACCEPTED
- **Date:** 2026-08-02
- **Decider:** Funpay CTO
- **Scope:** `services/ml-service/workers/underwriting_worker.py`,
  `services/ml-service/tests/test_underwriting_worker.py`,
  `services/ml-service/pytest.ini`
- **Supersedes:** the "Defect 1" entry in `services/ml-service/pytest.ini` and the
  matching line in `.github/workflows/ci.yml` (tracked in #428)

## Context

11 tests in `tests/test_underwriting_worker.py` were deselected by name in
`pytest.ini` under "Defect 1." All 11 patch
`workers.underwriting_worker.call_decision_engine`, a function that does not
exist anywhere in the module. On the surface this reads as a straightforward
gap: implement `call_decision_engine`, make an HTTP call to a decision
engine, and the tests pass.

Before doing that, I traced where this worker actually sits in the running
system. Three findings, each verified directly against `main` on this branch:

1. **Nothing produces jobs onto the `vida-underwriting` queue.**
   `grep -rn "vida-underwriting\|underwrite_loan"` across the repo returns
   only: the consumer itself (`workers/underwriting_worker.py`), the shared
   queue-name constant (`services/shared/queues.js:7`), health/stats
   queue-name lists in `services/payment-server/index.js:93,297` and
   `services/shared/health-monitor.js:125`, `services/ml-service/main.py:185`
   (reads queue depth for a stats endpoint), the unrelated Node HTTP service
   `services/underwriting-service/` (a same-prefix, different-service name
   collision — `vida-underwriting-service`, not `vida-underwriting`), and
   Railway env config. No producer exists anywhere.

2. **The worker is never started.** `services/ml-service/Dockerfile` ends in
   `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3005", ...]`
   — a FastAPI HTTP service. Nothing in the image, in Railway config, or
   anywhere else invokes `workers/underwriting_worker.py`'s
   `if __name__ == "__main__": asyncio.run(start_worker())`. The module's
   docstring claimed it "processes jobs dispatched by the requestLoan
   Firebase Function" (now corrected — see Actions below); that claim was
   false on this branch.

3. **The real, live underwriting path is synchronous HTTP, not this queue.**
   `functions/src/index.ts:338-356` reads `UNDERWRITING_SERVICE_URL` and
   calls `POST /underwrite` on `services/underwriting-service/`, which runs
   `decision-engine.js`. That is the path every loan in production actually
   goes through.

So the 11 tests specify a decision-engine integration for a BullMQ consumer
that is unreachable in production: it has no producer and is never started.
Implementing `call_decision_engine` to turn them green would not connect the
tests to the live system — it would build a **second, parallel scoring
path** that diverges from the one borrowers are actually underwritten by.

### Why that specific shape is disqualifying here

This repo has already shipped exactly this defect class once. Commit
`c0ce432` ("chore(loans): a dead second loan module still priced loans at
8% (#420)") removed `functions/src/loans/requestLoan.ts` — a complete,
tested, second implementation of loan creation that nothing imported, sitting
next to the live handler in `functions/src/index.ts`. It hardcoded
`FLAT_FEE_RATE = 0.08` while the live path charged the admin-configured 30%
(`getLoanConfigValues()`). It read as authoritative — it had passing tests
and clean field names — and that is precisely what made it dangerous: it
kept the wrong number circulating in specs and mockups (documented as
**P0-2**, `outputs/CRITICAL_DEFECTS.md` — borrowers quoted 8%, charged 30%,
a 3.75× gap on the amount actually collected).

A fully-implemented, fully-tested `call_decision_engine` in an unreferenced
worker is the same shape: a second scoring path, passing its own tests,
with no forcing function to keep it in sync with `decision-engine.js`. It
would look done. It would not be live. The next engineer who found it —
during an incident, or while wiring up "the ML worker" for some future
async use case — would have no way to tell from the code alone that it was
never the path borrowers went through, and could plausibly wire it up
believing it already worked.

## Decision

**Delete the 11 tests. Do not implement `call_decision_engine`.**

1. `test_underwriting_worker.py` keeps its 6 genuinely-passing tests (5 pure
   helper-function tests + `test_live_job_processing`, skipped by default)
   and the 3 model-loading tests still blocked on Defect 2 (PR #430, out of
   scope here). The 11 decision-engine/fallback/notification/stage-data
   tests, and the fixtures (`GOOD_JOB_DATA`, `ENGINE_APPROVED_RESPONSE`,
   `make_job`, `_make_mocks`, etc.) that existed only to support them, are
   removed outright — not skipped, not xfailed. A skip or xfail would keep
   describing behavior for a path we are explicitly not building.
2. The matching 11 `--deselect` lines and their "Defect 1" comment block are
   removed from `pytest.ini`. Defect 2's 3 lines and the joblib-artifact
   discussion are untouched (owned by PR #430).
3. `underwriting_worker.py` itself is **not deleted**. It is not dead code
   in the sense of being safe to remove without a product call — it
   represents a real architectural question (see Follow-up). Only its
   module docstring is corrected: it no longer claims to receive jobs from
   `requestLoan`, and states plainly that it is currently unreferenced.
4. The `ml-service` CI job comment in `.github/workflows/ci.yml` is updated
   to stop describing 14 deselected tests; it now describes the 3 that
   remain (Defect 2 only).

## Why this differs from ADR-003's precedent

[[ADR-003-lending-slot-autoscale-not-implemented]] kept its two suites in
the tree, deselected rather than deleted, because they were genuine
specifications for a feature that should eventually exist, blocked only on
an open commercial rule. That reasoning does not transfer here: those tests
described intended behavior of code on the live path. These 11 describe
intended behavior of a call from a worker that is not on the live path at
all, integrating with a queue nothing feeds. Keeping them as "executable
specifications" would specify the wrong system — the one to build, if a
queue-based async underwriting path is ever wanted, is a new design against
the current `decision-engine.js` contract, not a resurrection of this
worker's assumed one. There is nothing here worth preserving as a spec.

## Consequences

**Good:**
- The `ml-service` test gate no longer carries an 11-test placeholder for
  work that should not be done as originally specified. Its deselect list
  now maps 1:1 to a genuinely open, in-flight fix (Defect 2 / PR #430).
- No second scoring path enters the codebase. The single-decision-path
  invariant that `c0ce432` restored for loan creation is not immediately
  re-broken for underwriting.
- The worker's docstring stops asserting something false about production
  wiring, which is itself a small landmine defused.

**Bad / accepted:**
- Whatever the 11 tests specified (decision-engine call, fallback to local
  model on failure, notification/stage-data persistence) is no longer
  written down anywhere executable. If an async underwriting path is wanted
  later, it gets designed fresh against `decision-engine.js`'s actual
  contract, which costs more than reviving these tests would have — but
  reviving them would have meant building against an assumption (a
  `/pipeline` decision-engine response shape) that was never validated
  against the real service.
- `underwriting_worker.py` (405 lines: champion/challenger routing, fraud
  pre-screen, active-learner review routing, Firestore + Redis integration)
  remains in the tree, unstarted, unreferenced by any producer. It is not
  costing correctness — it cannot run — but it costs comprehension: it looks
  like live infrastructure to anyone who hasn't traced the queue.

## Rejected alternatives

- **Implement `call_decision_engine`.** The obvious fix. Rejected: builds a
  second decision path with no producer forcing it to stay in sync with the
  live one — the `c0ce432`/P0-2 shape.
- **Deselect instead of delete, as ADR-003 did.** Rejected: ADR-003's suites
  specified live-path behavior blocked on an open commercial question; these
  specify a path that architecturally should not exist as assumed. Nothing
  to wait on.
- **Delete `workers/underwriting_worker.py` entirely.** Rejected as outside
  this task's authority — see Follow-up. Removing a 405-line worker module
  is a product/architecture call, not a test-hygiene one.
- **`continue-on-error` / widen the pytest.ini exclusion to the whole
  file.** Rejected per the standing rule in `pytest.ini`'s header comment:
  it would also silently stop running the 6 tests that genuinely pass.

## Follow-up work

- [ ] **Open question for Isaac, not decided here:** should
      `underwriting_worker.py` be deleted, or is there a real near-term plan
      to make underwriting async (a producer enqueues onto
      `vida-underwriting`, the worker is actually started, and its
      champion/challenger/fraud-prescreen logic — which is materially more
      sophisticated than `decision-engine.js`'s current implementation — gets
      wired to the live path)? Until answered, the module sits in the tree
      correctly labeled as unreferenced rather than actively misleading.
- [ ] Defect 2 (numpy/joblib artifact) — in flight in PR #430, unaffected by
      this ADR.

## Related

- `outputs/CRITICAL_DEFECTS.md` — P0-2
- Commit `c0ce432` — the precedent this decision is built on
- [[ADR-001-ml-shadow-mode-gate]] — same module family
  (`services/ml-service`), different question (model authority, not
  reachability)
- [[ADR-003-lending-slot-autoscale-not-implemented]] — contrasting precedent
  on deselect-vs-delete, discussed above
- GitHub issue #428
