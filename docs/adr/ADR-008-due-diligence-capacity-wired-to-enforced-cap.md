# ADR-008 — Due-diligence capacity is wired to the field the loan-cap transaction enforces

- **Status:** ACCEPTED and IMPLEMENTED — shipped in #487 (`be6ea27`), merged 2026-08-03.
- **Date:** 2026-08-03
- **Decider:** Funpay CTO (engineering) — a wiring fix inside the rule Isaac already
  ratified in [[ADR-007-lending-slot-hybrid-growth]]; it sets no new commercial value and
  makes no new commercial ruling.
- **Closes:** the enforcement half of [[ADR-005-underwriting-spec-vs-implementation-reconciliation]]
  Finding 2 ("nothing persists or enforces a slot count") for Tier-1/Tier-2 due-diligence
  capacity specifically. Finding 2's broader claim — no schema, no ledger — is resolved by
  this ADR plus #485 (the enforcement transaction itself, landed before this ADR).
- **Depends on:** [[ADR-007-lending-slot-hybrid-growth]] (the capacity rule and the
  `activeSlots`-producing helpers this ADR renames) and #485 (`requestLoan`'s slot-cap
  transaction, which this ADR feeds).

## Context

ADR-007 ratified the Tier-1 growth rule and shipped the helpers that compute it
(`autoScaleTier1`, `expandTier2`, `computeInitialSlots`) inside
`runEmployerDueDiligence` (`services/underwriting-service/src/stages/employer-b.js`),
wired in by #486. That function returned the computed number as `activeSlots`.

Separately, and already landed by the time #486 shipped, #485 gave `functions/src/index.ts`'s
`requestLoan` a transaction that enforces a per-employer cap (ADR-005 Finding 2). That
transaction reads a field named `maxActiveSlots`.

Nothing wrote `maxActiveSlots`. #486's own PR description flagged this as a known,
deliberately-unfixed gap: due diligence computed a capacity and persisted it under one
name; enforcement read a different name that no code path ever set. The practical effect:
a Tier-1 employer due-diligence-scored for, say, 40 slots stayed capped at the
`riskTier`-absent fallback of 3 forever — the same defect class #485 had just fixed one
field over, and for the same underlying reason (a value computed in one place was never
threaded to the place that enforces it).

#486 did not fix this inline because renaming `activeSlots` straight into `maxActiveSlots`
would let an automated due-diligence re-score silently overwrite an ops-set expansion from
`updateEmployerTier`'s `approve_expansion` action, in either direction, on live lending
exposure — and no rule existed for which source should win. That needed a ratified
precedence rule, not an inline guess, so it was tracked as follow-up work rather than
guessed at under #486.

## Decision

1. **Rename, don't duplicate.** `employer-b.js`'s `runEmployerDueDiligence` now computes
   and returns `maxActiveSlots` instead of `activeSlots`, throughout the function and its
   Firestore write. This is capacity — a ceiling — and is a distinct concept from the
   slots-*in-use* count, which `requestLoan` computes separately via its own aggregate
   `count()` query inside the enforcement transaction. The two must never be wired into
   each other; the header comment in `employer-b.js` says so explicitly.
2. **`requestLoan` persists the due-diligence capacity onto the employer**, in its own
   transaction, immediately after computing `employerB`'s result and before the
   loan-creation transaction runs. This write is deliberately **fail-soft**: it is wrapped
   in its own `try`/`catch`, entirely separate from the loan-creation transaction, so a
   failure to persist the updated cap can never block the loan itself — the same
   convention `underwritingDecision` and `recordInlineMlDenial` already follow immediately
   above it, and for the same reason (a side-effect write must not gate the primary
   transaction it sits beside).
3. **Ops overrides win, and a missing source is not an override.** `updateEmployerTier`'s
   `approve_expansion` action now tags the employer document with
   `maxActiveSlotsSource: 'ops_override'` alongside the `maxActiveSlots` value it sets.
   Both automated write paths — `requestLoan`'s persistence step and
   `runEmployerDueDiligence`'s own Firestore write — read that field first (inside a
   transaction, to avoid a read/write race against a concurrent ops action) and skip the
   `maxActiveSlots` write when the stored source is `'ops_override'`. An employer with no
   `maxActiveSlotsSource` at all (a legacy or seeded record predating this field) is *not*
   treated as an override, so due diligence can still write a first value for it.
4. **Every due-diligence cap write is audit-logged** via the existing `auditLog` helper,
   under the action `employer.due_diligence_cap`, recording the before/after
   `maxActiveSlots` and `maxActiveSlotsSource`.

This required two commits inside #487. The first guarded only `requestLoan`'s write
against `ops_override`; it left `runEmployerDueDiligence`'s own Firestore write
unguarded, so an ops-approved expansion was silently reverted on the *next* automated
due-diligence run rather than the next loan request. The second commit moved that write
into a transaction that reads `maxActiveSlotsSource` first and freezes the cap when ops
owns it — score, tier, and timestamps still refresh either way. Both write paths now
apply the same precedence rule.

## Implementation

- `services/underwriting-service/src/stages/employer-b.js`: `activeSlots` renamed to
  `maxActiveSlots` in `runEmployerDueDiligence`'s local variables, its Firestore update,
  and its return shape. The update is now inside `db.runTransaction`, reading
  `maxActiveSlotsSource` before deciding whether to include `maxActiveSlots` /
  `maxActiveSlotsSource` in the write.
- `functions/src/index.ts`'s `requestLoan`: after the existing due-diligence stage call,
  reads `employerB`'s `maxActiveSlots` off the stage result and, if it is a number, runs a
  transaction that reads the employer's current `maxActiveSlotsSource`, skips the write if
  it is `'ops_override'`, otherwise updates `maxActiveSlots` /
  `maxActiveSlotsSource: 'due_diligence'` and audit-logs the change. Wrapped in `try`/`catch`
  so a failure only logs a warning (`logger.warn`) and never throws into the caller.
- `functions/src/index.ts`'s `updateEmployerTier`: the `approve_expansion` action now also
  sets `maxActiveSlotsSource: 'ops_override'` on the same update, and the audit log's
  `before` snapshot now includes the prior `maxActiveSlotsSource`.
- Tests: `functions/src/__tests__/requestLoan.test.ts` gained coverage for the
  persistence write, the fail-soft `catch`, and the `ops_override` guard.
  `services/underwriting-service/src/stages/__tests__/employer-b.test.js` gained coverage
  for the renamed field and the transaction-guarded write, including three new
  ops-override regression cases. Verified on this branch at merge: underwriting-service
  19 suites / 346 passed / 1 skipped (up from 343 passed before the three new
  ops-override cases); `requestLoan.test.ts` 42 passed; `tsc --noEmit` clean.

## Consequences

- A Tier-1 or Tier-2 employer that due diligence scores above the `riskTier`-absent
  fallback of 3 now actually receives that capacity at the point `requestLoan` enforces
  it, closing the gap #486 shipped with and flagged.
- An ops-approved expansion (`updateEmployerTier`'s `approve_expansion`) is now durable
  against both automated write paths that could otherwise revert it — the next loan
  request and the next scheduled due-diligence re-score.
- `maxActiveSlots` (capacity, a ceiling) and the slots-in-use aggregate `count()` inside
  `requestLoan`'s enforcement transaction remain two distinct numbers computed two
  different ways. Nothing in this change merges them, and the comments in both files say
  explicitly that they must not be.
- This ADR does not revisit ADR-007's growth rule, its tunables, or ADR-005's remaining
  open commercial questions (C2's Tier-2 portion, C4). It only connects a number ADR-007
  already ratified to the enforcement point ADR-005 Finding 2 / #485 already built.

## Alternatives rejected

- **Ship the rename without the `ops_override` guard**, as #486 originally considered and
  explicitly declined to do inline. Rejected because an automated re-score would then
  silently overwrite a human ops decision on live lending exposure the very next time
  either `requestLoan` or `runEmployerDueDiligence` ran — an unratified, unannounced
  precedence rule guessed at under a PR that was scoped to something else.
- **Guard only the `requestLoan` write and leave `runEmployerDueDiligence`'s own write
  unguarded.** This is what the first of #487's two commits actually shipped, briefly,
  within the same PR. Rejected once reviewed, because the due-diligence write path still
  reverted an ops override on its own schedule — later, but just as silently.
- **Treat a missing `maxActiveSlotsSource` as an override (fail closed on ambiguity).**
  Rejected because it would freeze every legacy/seeded employer record at whatever
  `maxActiveSlots` value it happened to carry before this field existed, permanently
  excluding them from automated due-diligence growth with no way back short of a manual
  ops action on every one of them.

## Related

- [[ADR-005-underwriting-spec-vs-implementation-reconciliation]] — Finding 2, the
  enforcement gap this closes the last piece of
- [[ADR-007-lending-slot-hybrid-growth]] — the ratified growth rule this ADR wires to
  enforcement; not reopened here
- #485 — `requestLoan`'s slot-cap enforcement transaction, the field this ADR feeds
- #486 — wired ADR-007's helpers into `runEmployerDueDiligence`, produced `activeSlots`,
  and flagged the gap this ADR closes as deliberately out of scope
- #487 — this change
