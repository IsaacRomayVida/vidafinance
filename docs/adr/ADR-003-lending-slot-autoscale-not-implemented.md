# ADR-003 — Lending-slot auto-scaling stays unimplemented; CI gate goes hard around it

- **Status:** SUPERSEDED by ADR-007
- **Date:** 2026-08-02
- **Decider:** Funpay CTO
- **Authority:** Isaac, 2026-08-02: "get it done now, stop asking me."
- **Supersedes:** `builds/STATUS.md` "Blockers for Isaac #2"

## Context

Two suites in `services/underwriting-service` stay red after the test-harness repair
(`stage3-autoapprove.test.js`, `employer-b.test.js`). `docs/AUDIT_05_TEST_COVERAGE.md`
categorised these as import/export name mismatches. They are not. They are
**specifications for features that were never built**:

- `stage3`: tests expect `runStage3` / `evaluateGate` / `hasCompetitorLoans(accounts)`
  with 10 named conditions including competitor-name string matching. Source exports
  `runAutoApproveGate` / `evaluateAutoApprove` — a materially simpler algorithm whose
  condition 5 is a numeric count with no string matching.
- `employer-b`: tests expect weighted scoring (`scoreSATAge`, `scoreDENUE`,
  `scoreIMSSEmployees`, `WEIGHTS`), tier auto-scaling, and Firestore writes. Source
  exports one flat +/- point scorer, `runEmployerDueDiligence`, with no Firestore
  integration.

**The tests contradict each other on the core rule.** The unit test asserts
`autoScaleTier1(10, 3).newSlots === 40` — +10 per clean payroll cycle. The integration
test at L356 uses `cleanPayrollCycles: 4` on 30 slots and expects 40, commented
`// 30 + 10` — flat. Both cannot be right.

## Decision

**Do not implement it.** The two suites are excluded from the hard CI gate by name,
with the reason recorded at the exclusion site and tracked in a GitHub issue. The rest
of the underwriting suite flips to a hard gate.

## Reasoning

1. **This is lending-slot allocation — it decides how much credit an employer's
   workforce can draw.** Guessing between +10/cycle and flat +10 bakes an unratified
   credit-exposure rule into production. On a Tier-1 employer with 4 clean cycles the
   two readings differ by 30 slots.
2. **There is no correct answer available in the repo.** The specification contradicts
   itself. No amount of engineering care resolves it; only someone who knows the
   intended commercial rule can.
3. **The alternative failure modes are both worse.** Deleting the tests to reach green
   destroys the only record that these features were ever specified. Implementing to
   match the impoverished current source would make the tests lie about what the system
   does.
4. **"Stop asking me" is not "guess on my behalf about credit exposure."** Isaac's
   instruction is to stop stalling on reversible calls. Silently inventing a lending
   rule is not reversible once loans are written against it — the loans are already out
   the door. So I am deciding the *engineering* question (exclude, gate hard, track)
   and leaving the *commercial* rule genuinely open, visibly, rather than pretending it
   is answered.

## Consequences

- The underwriting suite becomes a real hard gate today rather than "someday, once two
  unbuilt features are built." That is the practical win — 10 of 12 suites now
  genuinely protect against regression.
- The two excluded suites remain in the tree as executable specifications. When the
  commercial rule is settled, they become the acceptance criteria.
- The exclusion is **named and narrow**, never a wildcard. Any new failure in any other
  suite fails the build.
- A GitHub issue tracks the open commercial question so it does not live only in a
  branch comment.

## Alternatives rejected

- **Implement the flat +10 reading** (matches the integration test). Arbitrary; the
  unit test is equally authoritative and disagrees.
- **Delete both suites.** Destroys the specification and manufactures a green build.
- **Keep the whole underwriting suite on `continue-on-error` indefinitely.** Leaves 10
  healthy suites unprotected because 2 are blocked on a product decision. This is the
  status quo that let a 235-test suite go ungated for months.

## Related

- `outputs/CRITICAL_DEFECTS.md`
- PR #386 — the test-harness repair that surfaced this
- [[ADR-002-fee-rate-single-source-of-truth]]
