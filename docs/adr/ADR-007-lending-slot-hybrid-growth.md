# ADR-007 — Lending-slot hybrid growth: +10 per clean cycle, credited at review, capped at 2 increments

- **Status:** ACCEPTED
- **Date:** 2026-08-03
- **Decider:** Isaac (voice, relayed via Funpay CTO)
- **Supersedes:** [[ADR-003-lending-slot-autoscale-not-implemented]]
- **Answers:** ADR-005 commercial question C1 in full, and the `slotIncrement` /
  `maxIncrementsPerReview` / `tier1MaxAutoSlots` portion of C2
- **Extends, does not close:** [[ADR-005-underwriting-spec-vs-implementation-reconciliation]]
  Finding 2 (no slot persistence or enforcement exists in production) remains open — see
  Consequences.
- **Parallel:** ADR-006 (credit-policy ratification) lands in the same conversation, in a
  sibling branch/PR, and is not created or edited here.

## Context

A **slot** is one employee at one company allowed to have a loan outstanding at the same
time; it caps how much of Funpay's money can sit at a single employer.

ADR-003 (2026-08-02) declined to implement Tier-1 slot auto-scaling because it read
`employer-b.test.js` as self-contradictory: the unit test `autoScaleTier1(10, 3)` expects
`newSlots === 40` (read as "+10 per clean cycle"), while the integration test at
(then) L389-400 gives an employer 30 active slots and 4 clean cycles and also expects 40
(read as "flat +10 per evaluation"). ADR-003's own words: "Both cannot be right."

ADR-005 (2026-08-03, same day) went further and showed ADR-003's contradiction was a
misreading: **all six existing fixtures are simultaneously satisfiable** if
`autoScaleTier1`'s second parameter is read as "increments to apply" and the call site
always passes `1` — i.e., exactly one increment is credited per due-diligence evaluation,
regardless of how many payroll cycles elapsed since the last one. ADR-005 framed the real
open question (C1) as a choice between exactly two readings:

| Option | Rule | 30 slots, 4 clean cycles | Growth pace |
|---|---|---|---|
| A | One increment per due-diligence evaluation | 40 | Throttled by review cadence |
| B | One increment per clean payroll cycle | 70 | Throttled by payroll frequency |

ADR-005 recommended A on shape grounds but left it explicitly to Isaac, alongside C2 (the
slot constants — incumbent and internally consistent, but never formally ratified).

**Isaac's ruling, relayed today, is neither A nor B.** It is a third rule this ADR calls
the hybrid: increments are *earned* per clean payroll cycle (B's rate), but *credited*
only at a due-diligence review (A's throttle point), and credit per review is capped —
"let's do two max." Because it combines a rate ADR-005 didn't pair with a cap, it produces
numbers that satisfy neither A (40) nor B (70) for the fixture above: **50.** Both
existing fixtures (`autoScaleTier1(10, 3)` and the 30-slot/4-cycle integration case)
therefore needed rewriting again, for a third, different reason than either prior document
anticipated.

## Decision

**The ratified rule (Tier 1 only; Tier 2's manual-gate bands are unaffected and unchanged):**

1. A Tier-1 employer **earns** one growth increment (+10 slots) per clean payroll cycle
   since its last due-diligence review.
2. Earned increments are **credited only at a due-diligence review** — they do not accrue
   into live exposure between reviews. A review that finds 4 clean cycles since the last
   one does not silently grant 40 slots' worth of growth; nothing changes until the review
   runs.
3. **At most 2 increments (20 slots) are credited per review**, regardless of how many
   clean cycles were earned. Isaac's stated reason: a weekly-payroll employer must not be
   able to outrun Funpay's own oversight cadence by accumulating cycles faster than they
   are reviewed.
4. Credited growth never pushes a Tier-1 employer's slot count past the **100-slot
   ceiling**. A review whose potential credit would cross the ceiling clamps to 100 and
   flags `requiresManualReview`.
5. Tier boundaries are unchanged: Tier 1 is score >= 70 (auto-scale 10 -> 20 -> ... -> 100);
   Tier 2 is 40-69 (manual gate, max 3 starting slots, unaffected by this ADR).

**Open question, decided conservatively pending Isaac's confirmation:** what happens to
clean cycles earned beyond the 2-increment cap in a single review — 4 cycles at a review
that can only credit 2? Two readings are available and the brief this ADR is based on does
not settle between them:

- **Forfeit (adopted here).** The surplus 2 cycles are dropped; they do not carry forward
  to the next review, and the employer starts the next accrual period at zero earned
  cycles.
- **Carry-forward.** The surplus 2 cycles are banked and combine with cycles earned before
  the next review, subject to that review's own 2-increment cap.

**This ADR adopts forfeit**, the conservative reading: exposure should not be able to step
twice in one oversight window merely because an employer ran more payrolls than Funpay
reviewed it. Carry-forward would let a fast-payroll employer "save up" earned growth and
apply it at a moment of Funpay's choosing rather than have it expire — arguably fairer to
the employer, but it also means a backlog of unreviewed growth sits latent and could be
released all at once later, which is closer to the outrun-oversight failure mode C1 exists
to prevent. No evidence in the repository indicates carry-forward was intended. **This is
explicitly flagged back to Isaac as a question worth confirming**, not a settled point —
see the engineering report accompanying this PR.

## Implementation

- `services/underwriting-service/src/stages/employer-b.js` gains `autoScaleTier1`,
  `expandTier2`, `assignTier`, and `computeInitialSlots` as named exports, implementing
  the rule above. `autoScaleTier1(currentSlots, cleanPayrollCycles, config)` returns
  `{ newSlots, requiresManualReview, incrementsCredited, cyclesForfeited }` —
  `cyclesForfeited` makes the forfeit decision observable rather than silent.
- The three tunables the rule depends on — increment size, max increments per review, and
  the Tier-1 ceiling — are **server-side configuration**, not hardcoded constants, on the
  same seam ADR-002 built for the loan fee rate and `src/config/competitorLenders.js` /
  `src/config/maxPDefaultCutoff.js` already follow: a compile-time seed, a single Firestore
  document (`config/lendingSlotGrowth`), and a read path
  (`src/config/lendingSlotGrowth.js`, `getSlotGrowthConfig()`) that returns the seed when
  the document does not exist and **throws** — never silently reverts to the seed — when
  the document exists but cannot be trusted. `autoScaleTier1` defaults to the seed
  synchronously so it stays a pure, testable function; a caller wired to the server config
  resolves `getSlotGrowthConfig()` first and passes the result in.
- `expandTier2` (Tier 2's fixed-band expansion, 3 -> 6 -> 10) and `assignTier` /
  `computeInitialSlots` were never in contradiction (ADR-005 Finding 1) and needed no
  ruling; they are implemented directly from the existing, undisputed fixtures.
- `services/underwriting-service/src/stages/__tests__/employer-b.test.js`: the
  `assignTier`, `computeInitialSlots`, `autoScaleTier1`, and `expandTier2` `describe`
  blocks are un-skipped. The two contradictory fixtures are rewritten to the ratified
  rule (`autoScaleTier1(10, 3)` -> `newSlots: 30`, not 40; the 30-slot/4-cycle integration
  case -> `activeSlots: 50`, not 40) with comments explaining why, again, the number
  changed.

## Amends

- **ADR-003's finding of contradiction is superseded.** ADR-005 already showed the six
  original fixtures were arithmetically consistent under a single reading; this ADR
  additionally establishes that the reading ADR-005 identified (Option A) is not the one
  Isaac ratified, so the fixtures needed new values regardless.
- **ADR-005's engineering item 1** ("`autoScaleTier1`'s second parameter is `increments`,
  not cycles") assumed Option A would be chosen and recommended naming the parameter for
  that world. Under the ratified hybrid rule, the second parameter genuinely **is** clean
  payroll cycles earned since the last review — ADR-005's naming recommendation is
  superseded, not its underlying arithmetic proof.
- **ADR-005 commercial question C1** is answered: neither A (40) nor B (70), but the hybrid
  above (30 for the unit fixture, 50 for the integration fixture).
- **ADR-005 commercial question C2** is partially answered: `slotIncrement` (10),
  `maxIncrementsPerReview` (new — 2), and `tier1MaxAutoSlots` (100) are ratified and moved
  to the config seam. The remaining C2 items — `TIER_2_INITIAL_SLOTS`, the Tier-2
  expansion bands (3 -> 6 -> 10), `TIER_2_UPGRADE_CYCLES` (10), and the 70/40 tier
  thresholds — remain incumbent and undisputed but **not** formally ratified, exactly as
  ADR-005 left them, and are not on a config seam. That is unchanged by this ADR.

## Consequences

- `assignTier`, `computeInitialSlots`, `autoScaleTier1`, and `expandTier2` are implemented,
  tested, and un-skipped. `runEmployerDueDiligence` itself is **unchanged** — it does not
  yet call these helpers. Its rejected-employer tier encoding stays `3`, not the spec's
  `0`, per ADR-005 Finding 3: `stage3-autoapprove.js`'s `employerTier || 3` fallback chain
  depends on that exact contract, and that file is out of scope for this change (a sibling
  PR on `feat/adr006-gate-policy` owns it).
- **ADR-005 Finding 2 remains true and remains open**: there is no Firestore schema field
  for `activeSlots`, `cleanPayrollCycles`, or `tier` on the `employers/{employerId}`
  document; no persistence point; no enforcement point stopping a loan against an
  employer's eleventh slot. This ADR ratifies the *rule* and puts its *tunables* on a
  no-deploy config seam. It does not build the slot ledger, schema, or the call site that
  would invoke `autoScaleTier1` against a real employer record at review time — that is
  the remaining, larger piece of ADR-005 Finding 2 and Finding 9 in its Decision list, and
  is not part of what Isaac ratified today.
- The weighted scoring engine `employer-b.test.js` also specifies (`scoreSATAge` through
  `scorePayrollHistory`, `WEIGHTS`, and the Firestore-integrated rewrite of
  `runEmployerDueDiligence`) is **not** implemented here and remains `describe.skip`. It is
  a separate feature build (the scoring-model half of #387/#388) that this ADR does not
  cover.
- The carry-forward-vs-forfeit question above is decided conservatively (forfeit) but
  flagged, not closed. If Isaac later says carry-forward was intended, `autoScaleTier1`'s
  `cyclesForfeited` field is exactly the place that behavior would change.

> ## Subsequent developments (superseded-in-part; original Consequences left above for the record)
>
> Both gaps this ADR's Consequences section named as open, above, have since closed. This
> ADR's own text was accurate on 2026-08-03, the day it was written and ratified — nothing
> below rewrites it; it records what changed after.
>
> - **`runEmployerDueDiligence` now calls these helpers.** #486 (2026-08-03, "underwriting:
>   wire weighted scoring engine into runEmployerDueDiligence (#387) (#486)") wired
>   `assignTier`, `computeInitialSlots`, `autoScaleTier1`, and `expandTier2` into
>   `runEmployerDueDiligence`'s live Firestore-integrated path. The claim above — "it does
>   not yet call these helpers" — is no longer true as of that PR.
> - **The weighted scoring engine is no longer `describe.skip`.** #483 (2026-08-03,
>   "underwriting: implement employer-b weighted scoring helpers (#387/#388 scoring half)
>   (#483)") implemented `WEIGHTS` and the seven scoring signals
>   (`scoreSATAge` … `scorePayrollHistory`) and un-skipped their `describe` blocks; #486
>   then wired the resulting score into `runEmployerDueDiligence` in place of the ad-hoc
>   `let score = 50` accumulator the Consequences section above still describes.
> - As of #487 (`be6ea27`, 2026-08-03 — see [[ADR-008-due-diligence-capacity-wired-to-enforced-cap]]),
>   the capacity these helpers compute is also persisted to the field
>   `requestLoan`'s enforcement transaction actually reads, closing the remaining piece of
>   ADR-005 Finding 2 this ADR's Consequences section still lists as open.
> - Measured on this branch: `services/underwriting-service` — 19 suites, 346 passed, 1
>   skipped, 0 failed. The one remaining skip is unrelated to this ADR — an
>   unratified-shadow-model fixture in `stage3-autoapprove.test.js`, left skipped per
>   ADR-001 §Decision.2.

## Alternatives rejected

- **Adopt ADR-005's Option A (flat +1 increment per evaluation) without checking with
  Isaac.** ADR-005 explicitly left this to Isaac; guessing on it would repeat ADR-003's
  original mistake in the opposite direction.
- **Carry-forward by default.** Rejected as the initial reading precisely because it lets
  earned-but-uncredited growth bank silently, which is the failure mode the per-review cap
  exists to prevent. Adopted only if Isaac confirms it was intended.
- **Implement the full weighted scoring engine and Firestore integration in the same
  change.** That is a much larger, separate feature (the rest of #387/#388) with its own
  call-site and schema implications for `decision-engine.js` and
  `stage3-autoapprove.js`. Bundling it with today's narrow commercial ruling would risk
  the same kind of unratified scope creep ADR-003 was written to avoid.

## Related

- [[ADR-003-lending-slot-autoscale-not-implemented]] — superseded by this ADR
- [[ADR-005-underwriting-spec-vs-implementation-reconciliation]] — Finding 1 (arithmetic),
  Finding 2 (no persistence, still open), Finding 3 (tier-3 reject encoding, unaffected),
  commercial questions C1 and C2
- [[ADR-002-fee-rate-single-source-of-truth]] — the config-seam pattern this ADR's
  tunables follow
- `services/underwriting-service/src/config/lendingSlotGrowth.js`
- `services/underwriting-service/src/stages/employer-b.js`
- ADR-006 (parallel, credit-policy ratification) — not created or edited here
