# ADR-009 — The slot accrual ledger: two cycle counters, and the review boundary nobody has defined

- **Status:** ACCEPTED for the engineering shape; **two commercial questions OPEN** (Q1, Q2)
- **Date:** 2026-08-03
- **Author:** Funpay CTO (engineering). Q1 and Q2 are Isaac's alone.
- **Extends:** [[ADR-007-lending-slot-hybrid-growth]] (the rule),
  [[ADR-005-underwriting-spec-vs-implementation-reconciliation]] Finding 2 and Finding 9
  (the ledger)
- **Does not amend:** ADR-007's ratified rule. +10 per clean cycle, credited at review,
  max 2 increments, surplus forfeited, 100-slot ceiling — all unchanged. This ADR is
  about the ledger that rule operates on, and about the one boundary the rule presumes
  and the codebase does not have.
- **Not created or edited here:** ADR-007, ADR-008 (owned by a sibling branch this tick).

## Context — what was measured, not assumed

ADR-007's Consequences state that `runEmployerDueDiligence` "does not yet call these
helpers" and that there is "no persistence point; no enforcement point". Both statements
were true when written and are **now partly stale**. Measured against `6e5949d`:

| Claim in ADR-007 | Actual state today |
|---|---|
| No enforcement point | **Exists.** `requestLoan` (`functions/src/index.ts`) reads the employer's `maxActiveSlots` and an aggregate `count()` of active loans *inside the same transaction* as the loan write, and throws `EMPLOYER_SLOT_LIMIT_REACHED` on the 11th. |
| Nothing writes `maxActiveSlots` | **Wired by #487 / `be6ea27`.** `requestLoan` persists employer-b's computed capacity, guarded by `maxActiveSlotsSource: 'ops_override'`. |
| `runEmployerDueDiligence` never calls `autoScaleTier1` | **Calls it** (#486 / `23fcfa0`) — but see below. |

The part that was **not** measured before this change, and that turns out to matter more
than any of the above:

**`autoScaleTier1` was unreachable in production.** The employer object `requestLoan`
posted to the underwriting service was, verbatim:

```ts
employer: { rfc: employer['rfc'] || '', companyName: employer['companyName'] || '' },
```

`runEmployerDueDiligence` gates its growth branch on
`isReturning = (employer.maxActiveSlots || 0) > 0`. With only `rfc` and `companyName`
arriving, that was **always false**. Consequences, all of them silent:

1. Every Tier-1 employer was re-granted a flat `computeInitialSlots(1)` = **10 slots on
   every single loan request, forever**. ADR-007's growth rule could not fire once.
2. `scorePayrollHistory(employer.cleanPayrollCycles)` scored **0 for every employer in
   production**, permanently discarding 15 of the 100 available points — across the 70
   Tier-1 threshold.
3. `employer.employerId` was likewise absent, so employer-b's own Firestore write block
   (`employers/{employerId}`: `employerScore`, `tier`, `tierAssignedAt`,
   `lastDueDiligenceAt`, `dueDiligenceResult`) **never executed in production**. There is
   consequently no real `lastDueDiligenceAt` and no real `tier` anywhere in the employer
   book.

**And `cleanPayrollCycles` is written by nothing.** Not by a Cloud Function, not by the
underwriting service, not by the console, not by onboarding. It appears in production
source only as a *read*, three times, all in `employer-b.js`, all off the in-memory
argument. `grep` over the repository finds zero writers.

## Decision — the engineering shape (no commercial input required)

### 1. Two cycle counters, not one

`cleanPayrollCycles` was being asked to be two different quantities that two different
ratified rules read:

| Quantity | Read by | Ratified in |
|---|---|---|
| **Lifetime** clean cycles | `scorePayrollHistory` (full weight at 6+), `expandTier2`'s Tier-1 upgrade clock (eligible at 10) | ADR-005 Finding 1 item 2 — explicitly "lifetime clean cycles" |
| Cycles **since the last review** | `autoScaleTier1` | ADR-007 — "per clean payroll cycle **since its last due-diligence review**" |

Aliased onto one field, the two rules are **mutually unsatisfiable**: ADR-007 requires the
accrual to be consumed and forfeited at each review, and forfeiting it to zero also zeroes
the lifetime clock, so no Tier-2 employer could ever reach the 10 cycles that earn an
upgrade review. This is not a new ruling — it is forced by two rulings that already exist.

The employer document therefore carries both:

- `cleanPayrollCycles` — lifetime, monotonic, never reset.
- `cleanPayrollCyclesSinceReview` — the ADR-007 accrual window.

Naming follows the discipline #487 established for `maxActiveSlots`: the field says which
quantity it is, so the two can never be quietly wired into each other.

### 2. The ledger reaches the rule

`requestLoan` now sends the stored ledger (`tier`, `maxActiveSlots`, `cleanPayrollCycles`,
`cleanPayrollCyclesSinceReview`) on the underwriting payload, making `autoScaleTier1`
reachable at all.

**This is provably exposure-neutral today.** Nothing increments
`cleanPayrollCyclesSinceReview` (Q1), so it reads 0, so `autoScaleTier1` credits 0
increments and returns `currentSlots` unchanged. The observable change is that a Tier-1
employer's cap stops being recomputed from scratch on every request and starts being a
ledger. No employer's cap goes up.

`employerId` is deliberately **not** sent. Sending it would activate employer-b's own
Firestore write and make the underwriting service a second concurrent writer of
`maxActiveSlots`, racing #487's. `requestLoan` stays the single writer.

### 3. `tier` is persisted, and anchors which ladder the next review re-enters

A stored slot count is a position on **one** tier's ladder, not a portable number. Without
a persisted tier:

- a Tier-1 employer downgraded to Tier 2 carrying 50 slots gets `expandTier2`'s **top
  band (10)** instead of the initial band (3);
- a Tier-2 employer upgraded to Tier 1 carrying 3 slots gets `autoScaleTier1(3, …)`, which
  can land it **below** the 10 slots a fresh Tier 1 is granted.

So `tier` is written by `requestLoan` alongside the cap, and each ladder only accepts a
slot count earned on that same ladder. An **absent** prior tier still counts as returning:
that is the state of every employer in the book today, and demoting them all to a fresh
grant would move caps nobody chose — the same fail-direction reasoning
`initialSlotsForEmployerTier` already applies to an absent `riskTier`.

`tier` is refreshed even under `maxActiveSlotsSource: 'ops_override'`: ops owns the
**number**, not the score behind it. That is the split employer-b's own transaction
already makes.

### 4. Relationship between `tier` and `riskTier`, per ADR-005 Finding 2

ADR-005 flagged that a second `tier` field would give one document two tier vocabularies
"with no stated relationship". Stated, and recorded in `DATABASE.md`: **`tier` governs
slots and nothing else; `riskTier` (ML-assigned) governs the ML gates and pricing paths
and nothing else. Neither is derived from the other.**

### 5. The forfeit is auditable

`runEmployerDueDiligence` returns `slotGrowth`
(`{cyclesConsidered, incrementsCredited, cyclesForfeited, slotsBefore, slotsAfter}`), and
`requestLoan` records it in the `employer.due_diligence_cap` audit entry. A forfeit that
leaves no trace is indistinguishable from a cycle that was never earned.

### 6. The ledger's inputs are Admin-SDK-only

`firestore.rules` already blocked a self-serve employer from creating itself with
`maxActiveSlots`. It did not block the fields that **feed** it. An employer creating
itself with `tier: 1` and `cleanPayrollCyclesSinceReview: 2` would hand its first review a
pre-loaded accrual. Blocking the cap while leaving its inputs writable is not a cap;
`tier`, `maxActiveSlotsSource`, both cycle counters, `employerScore` and
`dueDiligenceResult` are now blocked too.

## DECISION REQUIRED — commercial, Isaac's alone

Both were left unbuilt rather than guessed. ADR-003 guessed and was wrong; ADR-005 showed
ADR-003's premise was a misreading; ADR-007 then landed on a third rule neither had
anticipated. The pattern is that the plausible branch has been wrong three times.

### Q1 — What increments a clean payroll cycle, and what makes it "clean"?

The counter exists, is persisted, is read by the ratified rule, and is **written by
nothing**. Until this is answered, hybrid growth credits zero increments and every
employer's cap is frozen at its current value.

Answering it requires two things this repository does not contain:

- **The event.** There is no payroll-cycle observation anywhere — no webhook, no
  scheduled reconciliation, no field recording that employer X ran payroll on date Y.
  The Belvo/payroll-software clients verify employees; they do not observe cycles.
- **The predicate.** "Clean" is undefined. Zero borrower defaults in the cycle? Zero
  *delinquencies*, including cured ones? Full and on-time payroll deposit? A threshold
  (≤1% of that employer's borrowers late)?

Both directly set how fast an employer's credit line grows, so neither is mine.

### Q2 — What counts as "a due-diligence review" for crediting and forfeiting?

This is the sharper one, and it is a hole in ADR-007 rather than in the code.

ADR-007 credits at "a due-diligence review" and caps at 2 increments so that an employer
"cannot outrun **Funpay's own oversight cadence**". That phrasing presumes a periodic
review on a cadence Funpay controls.

**No such review exists.** `runEmployerDueDiligence` has exactly one caller: the
underwriting pipeline, which runs **on every loan request**. There is no scheduled
due-diligence job (`dailyLoanCheck`, `weeklyPortfolioSnapshot`, `systemHealthCheck`,
`queueHealthCheck` and `satBlacklistRefresh` are the only scheduled functions, and none
touches due diligence).

So "review" currently resolves to "any employee at this employer requested a loan", and
the two readings diverge sharply:

| Reading | Effect |
|---|---|
| **A review = every loan request** | The accrual window is the gap between two consecutive loan requests at that employer. A busy employer resets its counter constantly and can almost never bank a full cycle, so it **stops growing**; a quiet employer accrues freely. Credit growth ends up inversely proportional to borrowing activity — the opposite of a credit judgement, and the forfeit rule destroys the accrual on nearly every request. |
| **A review = a periodic due-diligence job** | Matches ADR-007's stated intent, but the job does not exist and its **cadence is the throttle** — choosing weekly vs. monthly vs. quarterly directly sets the maximum growth rate (20 slots per period). That is a credit-policy number, not a scheduling detail. |

**Nothing was built on either reading.** Specifically, `cleanPayrollCyclesSinceReview` is
**never reset to 0 by any code path** in this change, because the reset *is* the forfeit,
and where the reset fires is exactly what Q2 asks. `autoScaleTier1`'s cap-2-and-forfeit
arithmetic is implemented, tested and observable; its persistence waits on Q2.

If Q2 resolves to a periodic job, that job's cadence should be named in the answer, and it
belongs on the same no-deploy config seam as `slotIncrement` /
`maxIncrementsPerReview` / `tier1MaxAutoSlots`.

## Consequences

- ADR-007's rule is now reachable code rather than a tested-but-dead helper, and the
  ledger it needs is persisted, documented and rule-protected.
- **No employer's slot cap moves as a result of this change.** Growth is gated behind a
  counter that nothing increments. That is deliberate: it lets the plumbing ship and be
  reviewed without shipping a credit-policy guess with it.
- ADR-005 Finding 2 is now *mostly* closed — schema (`DATABASE.md`), persistence
  (`requestLoan`), enforcement (`requestLoan`'s transaction, since #487). What remains
  open is the accrual *source*, which is Q1.
- ADR-005 Finding 3 is untouched: `runEmployerDueDiligence` still encodes a rejected
  employer as tier `3` at the `stage3-autoapprove.js` boundary contract, and
  `assignTier` still returns `0` for the score band. Neither was changed here.
- The forfeit-vs-carry-forward question ADR-007 flagged remains decided-as-forfeit and
  still unconfirmed. Q2 partly subsumes it: if a review is every loan request, "forfeit"
  means something very different from what ADR-007 described.

## Alternatives rejected

- **Increment `cleanPayrollCyclesSinceReview` from an inferred signal** (e.g. "a month
  passed with no default at this employer"). That invents both the event and the
  predicate, and sets the growth rate. Exactly the class of guess ADR-003 made.
- **Add a scheduled monthly due-diligence job and call the cadence an implementation
  detail.** The cadence *is* the throttle ADR-007's cap exists to enforce. Picking it
  silently would set credit policy in a cron string.
- **Reset the counter on every loan request** (the only "review" that exists). Cheap,
  makes the code look finished, and quietly implements reading A of Q2 — a rule under
  which growth is throttled by borrowing volume, which nobody ratified.
- **Keep one `cleanPayrollCycles` field.** Makes ADR-005 Finding 1 item 2 and ADR-007
  unsatisfiable at the same time; see Decision 1.
- **Send `employerId` and let employer-b persist its own result.** Two concurrent writers
  of a credit-exposure cap in two services, for no gain.

## Related

- [[ADR-007-lending-slot-hybrid-growth]] — the ratified rule this ledger serves
- [[ADR-005-underwriting-spec-vs-implementation-reconciliation]] — Finding 2 (no
  persistence/enforcement), Finding 1 item 2 (lifetime cycles), Finding 3 (tier-3 reject
  encoding, unchanged here)
- [[ADR-002-fee-rate-single-source-of-truth]] — the config seam a Q2 cadence would follow
- #487 / `be6ea27` — the enforcement half this change is the accrual half of
- `services/underwriting-service/src/stages/employer-b.js`
- `functions/src/index.ts` — `requestLoan`
- `DATABASE.md` — `employers/{employerId}` lending-slot ledger
