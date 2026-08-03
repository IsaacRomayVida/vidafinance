# ADR-005 — Reconciling the underwriting spec with the underwriting implementation

- **Status:** PROPOSED — not accepted, not ratified. The commercial items below are
  Isaac's to settle; the engineering items are mine and are ready to accept.
- **Date:** 2026-08-03
- **Decider:** Funpay CTO (engineering shape); **Isaac** (every item marked DECISION
  REQUIRED — commercial)
- **Extends:** [[ADR-003-lending-slot-autoscale-not-implemented]], which decided *not to
  implement*. This ADR decides *what gets implemented when someone does*.
- **Closes the analysis for:** #387, #388

## Context

`services/underwriting-service` carries two committed test files that specify features
that were never built. ADR-003 held them out of the CI gate; PR #457 converted them from
`testPathIgnorePatterns` to `describe.skip` so jest counts the hole in the open rather
than hiding it. Verified on this branch, `npm test` in that package:

```
Test Suites: 2 skipped, 11 passed, 11 of 13 total
Tests:       78 skipped, 150 passed, 228 total
```

ADR-003 recorded the blocker as a single unanswerable question — the `autoScaleTier1`
rule — and stopped there, correctly, because the goal then was to get the other ten
suites behind a hard gate. This ADR is the follow-through: read both specs against both
implementations line by line and separate what is genuinely undecidable from what only
looked undecidable.

The result is that **most of it was decidable.** #388's blocking contradiction does not
exist as stated. What remains genuinely open is smaller, and it is commercial.

## Finding 0 — the ADR series is not in this repository

`.github/workflows/ci.yml:128` points a reader at `outputs/ADR-004-underwriting-worker-not-the-decision-path.md`.
`src/stages/__tests__/employer-b.test.js:27` and `src/stages/__tests__/stage3-autoapprove.test.js:40`
point at `docs/adr/ADR-003-lending-slot-autoscale-not-implemented.md`. Two different
directories, and `git log --all --diff-filter=A` shows no ADR file has ever been
committed to either. Every cross-reference in the code is dangling.

This ADR is filed at `docs/adr/` because that is the path the code under discussion
already cites. ADR-001 through ADR-004 should be moved in behind it and `ci.yml:128`
corrected, so that the decisions the source code defers to are readable by someone who
has only the source code.

---

# Part 1 — Employer slot allocation (#388)

## Finding 1 — `autoScaleTier1` does not contradict itself

#388 states that the unit test implies "+10 per clean payroll cycle", the integration
test implies "flat +10", and both cannot hold. Checked against the file, both hold.

The five unit assertions, in `src/stages/__tests__/employer-b.test.js`:

| Line | Call | Expected `newSlots` | `requiresManualReview` |
|---|---|---|---|
| 302 | `autoScaleTier1(10, 1)` | 20 | false |
| 308 | `autoScaleTier1(10, 3)` | 40 | false |
| 314 | `autoScaleTier1(90, 2)` | 100 (`TIER_1_MAX_AUTO_SLOTS`) | true |
| 320 | `autoScaleTier1(95, 1)` | 100 | true |
| 326 | `autoScaleTier1(10, 0)` | 10 | false |

These are consistent and complete: `newSlots = min(current + 10n, 100)`, with manual
review flagged when the uncapped result reaches the cap. The function is **fully
determined**.

The integration case at `employer-b.test.js:389-400` gives an employer `activeSlots: 30`,
`cleanPayrollCycles: 4`, and expects `40`.

The contradiction appears only if `n` is assumed to be `employer.cleanPayrollCycles`.
**Nothing asserts that.** The only place the phrase "per clean cycle" occurs is the test
title at `employer-b.test.js:301` — prose, not an assertion. `autoScaleTier1` is a pure
function called with two bare integers; its second parameter is never named in any
assertion. Read `n` as *increments to apply*, and with `n = 1` at the call site every one
of the six tests passes simultaneously.

Two further readings are ruled out arithmetically:

- **`n` = lifetime cycles.** `autoScaleTier1(30, 4)` = 70 ≠ 40. Fails the integration test.
- **`n` = cycles earned but not yet credited.** 30 slots is 10 initial (`computeInitialSlots(1)`,
  `employer-b.test.js:287-288`) plus two increments; 4 lifetime cycles minus 2 already
  credited is 2 owed, giving 50 ≠ 40. Also fails.

Only `n = 1` satisfies the fixture. The call site awards **one increment per due-diligence
evaluation**, regardless of how many cycles accrued since the last one.

The sibling function corroborates this independently. `expandTier2` takes lifetime clean
cycles as its second argument — it compares them against `TIER_2_UPGRADE_CYCLES`
(`employer-b.test.js:353` `expandTier2(10, 10)` is upgrade-eligible; `:364` `expandTier2(3, 9)`
is not) — and yet advances exactly **one** band per call: `:334` `expandTier2(3, 1)` → 6,
`:341` `expandTier2(6, 3)` → 10. The cycle count gates eligibility; it never multiplies
the grant. The Tier-2 integration case at `:432-448` matches — `activeSlots: 3`,
`cleanPayrollCycles: 2`, expecting `6`, one band.

And the shipped source says the same thing in a comment: `src/stages/employer-b.js:70`,
`maxSlots = 100; // auto-scale 10→20→...→100` — a ladder climbed a rung at a time.

### ENGINEERING SHAPE — recommended, decisively

`autoScaleTier1(currentSlots, increments)` returns
`min(currentSlots + TIER_1_SLOT_STEP * increments, TIER_1_MAX_AUTO_SLOTS)`. The second
parameter is **increments, not cycles**, and must be named `increments` at both the
definition and the call site. Rename the `describe` at `employer-b.test.js:301` off
"per clean cycle", which is the entire origin of this issue: a test title was read as a
specification and blocked a feature for two releases.

`expandTier2(currentSlots, lifetimeCleanCycles)` advances one band and uses cycles only
for `eligibleForUpgrade`. Its second parameter genuinely is cycles. The two functions
take different things and must not share a parameter name.

#388's question — "+10 per clean cycle, or flat +10?" — is therefore not a choice between
two implementations. It is a question about the call site only, and it survives as the
commercial item below.

## Finding 2 — nothing persists or enforces a slot count

`activeSlots`, `cleanPayrollCycles`, `TIER_1_INITIAL_SLOTS` and every other slot
identifier appear **only** inside `employer-b.test.js`. They exist nowhere in production
source, nowhere in `firestore.rules`, and nowhere in `DATABASE.md`.

The shipped `runEmployerDueDiligence` returns `maxSlots` — the tier *ceiling*, set to a
constant 100 / 3 / 0 at `employer-b.js:70`, `:73`, `:76` — and never a current grant. It
has no Firestore import at all (`employer-b.js:10-11` imports only `belvo-client` and
`payroll-software`), so it cannot read a prior slot count or write a new one. And
`grep` finds no consumer of `maxSlots` outside the function that produces it.

The documented `employers/{employerId}` schema (`DATABASE.md:13-42`) has no `activeSlots`,
no `tier`, no `employerScore`, and no `cleanPayrollCycles`. The Firestore assertions the
spec makes at `employer-b.test.js:486-498` write five fields that the schema does not
define.

**Ratifying a scale rule changes nothing on its own.** There is no slot ledger, no
schema, and no enforcement point that would stop an employer's eleventh employee
borrowing against ten slots. Whatever rule is chosen, the work is a persistence and
enforcement change, and the rule is the small part of it.

Related, and worth settling in the same change: `DATABASE.md:35` already defines
`riskTier` as an ML-assigned field on the same document. A second, unrelated `tier`
written by employer-b would give one document two tier vocabularies with no stated
relationship.

## Finding 3 — the rejected-employer tier encoding disagrees, and the gate is protected only by accident

The shipped code encodes a rejected employer as **tier 3** (`employer-b.js:76`). The spec
encodes it as **tier 0** (`employer-b.test.js:276-278`, `assignTier(39)` → `0`).

This is not cosmetic. `src/stages/stage3-autoapprove.js:30` reads:

```js
const employerTier = employerData.tier || applicant.employerTier || 3;
```

and `:33` passes condition 1 when `employerTier <= 2`.

If employer-b is rebuilt to the spec and starts emitting `0`, that `0` is falsy and falls
straight through the `||` chain. With no applicant-supplied tier it lands on the literal
`3` and fails safe. **With a stale or self-reported `applicant.employerTier` of 1 or 2, a
rejected employer's applicant passes condition 1.** The same encoding change also makes
`employer-b.js:79` (`pass = tier <= 2`) return `true` for a rejected employer.

Today's tier-3 encoding is safe. Adopting the spec's tier-0 encoding without touching
`stage3-autoapprove.js:30` introduces an auto-approve path for workers at employers the
system rejected.

### ENGINEERING SHAPE — recommended, decisively

Keep **3** as the rejected encoding, matching the shipped source and the existing
"tier 1 / 2 / 3" comment block at `employer-b.js:5-8`; rewrite `assignTier`'s spec to
expect 3. Then remove the `||` chain regardless: a tier is either present or the gate
must fail closed, and `||` cannot distinguish "absent" from "zero". `applicant.employerTier`
should not be a fallback source for a value the pipeline computes itself — that is the
same "trust the caller's shaping" pattern `decision-engine.js:62-64` already rejects for
the principal.

## DECISION REQUIRED — commercial: what earns a Tier-1 slot increment

Everything above is shape. This is the number.

| Option | Rule | Tier-1 employer, 4 clean cycles since last review, 30 active slots | Growth 10 → 100 |
|---|---|---|---|
| **A** | One increment per due-diligence evaluation | 40 | Paced by review cadence |
| **B** | One increment per clean payroll cycle | 70 | Paced by payroll frequency |

Consequences:

- **A** makes the *review cadence* the throttle. Capacity grows only as fast as Funpay
  chooses to re-run due diligence, which is a lever Funpay controls directly and can slow
  in a downturn without changing any rule. It matches the integration fixture, matches
  `expandTier2`'s shape, and matches the source's `10→20→...→100` ladder comment.
- **B** makes *payroll frequency* the throttle. A semi-monthly employer reaches the
  100-slot cap in roughly two years of clean history; a weekly one reaches it in about
  ten months, for identical credit quality. Tying credit capacity to how often a company
  runs payroll is an accident of the encoding, not a credit judgement — see #435 on how
  many pay-frequency vocabularies this codebase has carried.

**Recommendation is A**, but the recommendation is on the *shape* argument only (it is
the reading every other artifact agrees with) and it still sets lending capacity. **It is
not mine to ratify.**

**Measurement that should inform it:** the realised default rate on loans written against
slots 11 and above, by increment number, segmented by employer tier at the time of the
grant. Until slots are persisted at all (Finding 2) that measurement does not exist, which
is an argument for A on an additional ground: it is the slower of the two, and it is the
one whose pace can be changed without a deploy.

## DECISION REQUIRED — commercial: the slot constants

Incumbent in the shipped source and consistent across both artifacts, but never ratified:

| Constant | Incumbent | Where |
|---|---|---|
| `TIER_1_INITIAL_SLOTS` | 10 | `employer-b.js:70` comment; `employer-b.test.js:287-288` |
| `TIER_1_SLOT_STEP` | 10 | `employer-b.test.js:302-311` |
| `TIER_1_MAX_AUTO_SLOTS` | 100 | `employer-b.js:70`; `employer-b.test.js:314-322` |
| `TIER_2_INITIAL_SLOTS` | 3 | `employer-b.js:73`; `employer-b.test.js:291-292` |
| `TIER_2_EXPANSION_BANDS` | 3 → 6 → 10 | `employer-b.test.js:333-350` |
| `TIER_2_UPGRADE_CYCLES` | 10 | `employer-b.test.js:352-366` |
| Tier thresholds | 70 / 40 | `employer-b.js:68,71`; `employer-b.test.js:263-279` |

These are the only numbers in this analysis where the spec and the implementation already
agree, so no engineering choice is being made by keeping them. They are listed here
because "incumbent and undisputed" is not the same as "ratified", and every one of them
sets exposure. They should carry the same treatment ADR-002 gave the fee rate: one
definition, server-side, changeable without archaeology.

---

# Part 2 — The Stage 3 auto-approve gate (#387)

`stage3-autoapprove.test.js` does **not** contradict itself. It contradicts the shipped
`stage3-autoapprove.js` on four axes. Three of the four have an objectively better answer.

## Finding 4 — LTI is in different units, and the codebase has already voted

- **Producer:** `src/stages/stage2-bureau.js:91-95`. `computeLTI` returns a **percentage** —
  `Math.round((principal / netIncome) * 100 * 100) / 100`, with `return 100` for a
  fully-leveraged borrower. Written to `data.lti = { value, ... }` at `:197`.
- **Shipped consumer:** `stage3-autoapprove.js:57,60` — `stage2Data.lti?.value` compared
  `<= 25`. Percentage. Consistent with its producer.
- **Live, passing evidence:** `src/decision-engine.test.js:203` asserts
  `stages.stage2.data.lti.value` is `13.64`. That test runs green today.
- **The spec:** `stage3-autoapprove.test.js:179-183` passes `lti: 0.25` and `:171-177`
  fails `lti: 0.26`. A **fraction**. Its fixture at `:83` also supplies `lti` as a bare
  number, not the `{ value }` object the producer emits.

Under the shipped semantics the spec's failing case `0.26` means 0.26% and sails through.
Under the spec's semantics the real value `13.64` means 1364% and everything fails.

### ENGINEERING SHAPE — recommended, decisively

**Percentage wins.** One producer, one consumer and one green test already agree on it;
the fraction exists only in a suite that has never executed. Rewrite the spec to `25` and
`26`, and to read `{ value }`.

Note the adjacent trap: `services/ml-service` uses LTI as a fraction throughout
(`workers/underwriting_worker.py:143`, thresholds `0.15` / `0.35` in
`scripts/train_scorecard_champion.py:81-82`). The boundary is currently correct, because
`stage2-bureau.js:206` computes the ML feature `loan_to_salary_ratio` separately as a
fraction rather than reusing `data.lti.value`. So the same quantity is computed twice, in
two units, ten lines apart, with nothing naming either. Name them — `ltiPercent` and
`ltiRatio` — before someone helpfully deduplicates them.

## Finding 5 — the P(default) cutoff, and which model supplies it

- **Shipped:** `stage3-autoapprove.js:20` reads `APPROVAL_THRESHOLD` (default `0.65`) and
  `:98` passes when `pDefault < (1 - threshold)` — an effective cutoff of **0.35**.
- **Spec:** `stage3-autoapprove.test.js:226-232` requires `0.20` to **fail**, and
  `:301-311` requires `0.08` to **pass**, with the inline comment at `:308` naming
  **0.15**. The cutoff lies in (0.08, 0.20].

`0.20` is below the shipped cutoff of `0.35`, so the shipped gate auto-approves exactly
the applicant the spec requires it to escalate. The two are not close.

Two shape problems sit underneath the number, independent of which number wins.

**First, the cutoff is derived rather than declared.** An environment variable named
`APPROVAL_THRESHOLD` whose real meaning is `1 −` a maximum default probability is a
readable-only-by-its-author control. Anyone tightening credit by *raising* something
called an approval threshold would be loosening it.

**Second, the spec gates on the shadow model.** Its fixture at `stage3-autoapprove.test.js:85-87`
carries `champion: { pDefault: 0.05, model: "woe_scorecard" }` and
`challenger: { pDefault: 0.08, model: "xgboost", shadow: true }`, and `:309-311` asserts
condition 10 takes `0.08` — the challenger. [[ADR-001-ml-shadow-mode-gate]] §Decision.2 is
explicit that shadow output is "logged, not obeyed", and §Decision.3 that promotion is a
gated, signed-off event. Wiring a `shadow: true` model into a live approval condition is
precisely the promotion-by-accident ADR-001 exists to prevent.

### ENGINEERING SHAPE — recommended, decisively

1. Declare the cutoff directly as a single named `MAX_PDEFAULT`. No complement, no
   derivation from a differently-named variable. Its *value* is commercial.
2. The condition reads the **champion** model. The challenger is scored and logged in
   parallel, per ADR-001; promoting it is a separate ratified event, not a fixture choice.
3. Rename condition `xgboost_pdefault` (`stage3-autoapprove.test.js:231`) to `ml_pdefault`.
   A condition id that names a model vendor becomes a lie the day the model changes, and
   these ids surface in borrower-facing denial reasons.

Worth recording as a live tension rather than a defect: both the shipped gate and the spec
already let an ML score block an auto-approval. That is a veto, not authority — ML can
only push an applicant toward human review, never toward approval — so it is the
conservative direction. But it is still ML being obeyed, and ADR-001 should say plainly
whether a one-directional veto is inside or outside shadow mode.

## DECISION REQUIRED — commercial: the P(default) cutoff

| Option | Cutoff | Effect |
|---|---|---|
| Incumbent | 0.35 | Auto-approves anything under a 35% modelled default probability |
| Spec | 0.15 | Roughly halves the modelled-risk ceiling for the auto-approve path |

The source comment at `stage3-autoapprove.js:17` claims "55% approved here". Nothing in
the repo substantiates that figure at either cutoff.

**No recommendation.** This directly sets the approval rate and it is the single number
with the largest effect on the book. Per ADR-001 the model producing `pDefault` is trained
on synthetic data and its threshold "has no empirical basis" — so the honest position is
that **neither** number is currently defensible, and the cutoff should be set only
alongside the shadow-mode backtest ADR-001 §Follow-up already calls for.

**Measurement that should inform it:** the shadow log's realised default rate by predicted
`pDefault` decile, on real repayment outcomes. Until that exists, the choice is between two
guesses, and the more conservative guess is the cheaper mistake.

## Finding 6 — three of ten conditions differ

Seven conditions match by name and intent. The remaining three:

| Slot | Spec | Shipped |
|---|---|---|
| 8 | `dias_atraso_zero` (`test.js:215`) | `ml_default_prob` (`js:97`) |
| 9 | `cartera_vencida_false` (`test.js:223`) | `no_active_defaults` (`js:106`) |
| 10 | `xgboost_pdefault` (`test.js:231`) | `age_range` (`js:116`) |

`días de atraso` and `cartera vencida` are fields the Buró de Crédito returns directly.
`activeDefaults` is a count something would have to derive from them. And `age_range` is
by the shipped code's own admission at `stage3-autoapprove.js:15` already validated in
Stage 1. So the spec's set sits closer to the raw bureau payload and the shipped set
carries one re-check.

Which conditions gate credit is credit policy, so the set is commercial. One piece of it
is not:

### ENGINEERING SHAPE — recommended, decisively

Whichever set wins, conditions get **stable numeric ids alongside their names**. The spec
already assumes them (`test.js:150`, `:158`, `:166` … all match on `f.id`); the shipped
code emits `{name, pass, value, required}` with no id at all (`stage3-autoapprove.js:31-36`).
Denial reasons derived from these conditions reach borrowers and, under the CONDUSEF
regime, have to be referenceable across a rename. Ids are how that survives a rewrite.

## Finding 7 — competitor detection

- **Spec:** `hasCompetitorLoans(accounts)` keyword-matches creditor names —
  `stage3-autoapprove.test.js:92-122`, matching KUESKI, MoneyMan and CREDITEA against
  either `otorgante` or `nombreOtorgante`.
- **Shipped:** `stage3-autoapprove.js:66` reads a numeric `bureau.competitorLoans` count.
  No names, no matching.

Whether "holds a competitor loan" blocks auto-approval at all, and which lenders count, is
credit policy — commercial, below.

### ENGINEERING SHAPE — recommended, decisively

If name matching wins, the competitor list is **data, not code**. Three brand names
hardcoded in a credit gate go stale the week a fourth lender launches, and refreshing them
should not require a deploy — the same argument, and the same seam, as ADR-002's
`getLoanConfigValues()`.

Separately: the spec matching on `otorgante` *or* `nombreOtorgante`
(`stage3-autoapprove.test.js:107` vs `:112`) means the bureau adapter never settled which
field it emits. Settle that in the adapter, not in every consumer that has to guess.

## Finding 8 — the gate fails open, and the skipped spec is the fix's acceptance test

Five of ten conditions pass when their data is absent — `lti` (`js:57`), `no_competitor_loans`
(`:66`), `riskseal_score` (`:75`, where a missing fraud score reads as a perfect 100),
`sector_safe` (`:84`) and `no_active_defaults` (`:104`). This is already filed as **#458**
with the full table, raised by Funpay Design, and is not new work claimed by this ADR.

Two things this ADR adds to it.

**The spec already encodes the fix.** `stage3-autoapprove.test.js:253-269` feeds all-null
input and requires exactly **9** failures — every condition fails closed except
`no_competitor_loans`, which legitimately passes because an empty account list genuinely
means no competitor loans. That skipped test is the acceptance criterion for #458, and it
holds under *either* condition set. **It can be un-skipped and made to pass ahead of every
commercial ruling in this document** — it constrains only the missing-data behaviour, not
which conditions exist.

**The blast radius is one stage upstream.** `decision-engine.js:148` converts a Stage 2
throw into `{ pass: true, reason: "STAGE_ERROR_DEGRADED", data: {} }` and continues. The
gate then evaluates on an empty object. It still escalates today rather than approving —
but only because `bureau_score` (`js:48`, defaulting to 500) and `ml_default_prob`
(`js:94-98`, defaulting to 0.5) fail closed. Two conditions are the entire margin between
a total Stage 2 outage and an auto-approval.

The principle is already written down in this repo, at `decision-engine.js:66-72`, which
names this exact `0 <= 25` LTI hazard, and again in ADR-002's requirement 6 for the fee
config read path: *a pipeline that cannot see a value must refuse rather than approve
blind.* Stage 3 is the one place it was not applied.

---

## Decision

**Engineering shape — proposed for acceptance now, no commercial input required:**

1. `autoScaleTier1`'s second parameter is `increments`, not cycles (Finding 1).
2. `expandTier2`'s second parameter is lifetime clean cycles, advancing one band per call
   (Finding 1).
3. Rejected employers stay **tier 3**; the spec changes, not the code; and
   `stage3-autoapprove.js:30`'s `||` fallback chain is removed (Finding 3).
4. LTI is a **percentage** end to end in the underwriting service; `ltiPercent` and
   `ltiRatio` are named distinctly (Finding 4).
5. The P(default) cutoff is a single declared `MAX_PDEFAULT`, read from the **champion**
   model, with a vendor-neutral condition id (Finding 5).
6. Conditions carry stable numeric ids (Finding 6).
7. The competitor list is configuration, and the bureau adapter settles on one creditor-name
   field (Finding 7).
8. Every condition fails closed on missing data, per `decision-engine.js:66-72`. Tracked as
   #458; `stage3-autoapprove.test.js:253-269` is its acceptance test and is unblocked by
   everything else here (Finding 8).
9. Slot state gets a schema, a persistence point and an enforcement point, or none of the
   above matters (Finding 2).
10. ADR-001 through ADR-004 move into `docs/adr/`; `ci.yml:128` is corrected (Finding 0).

**Commercial — DECISION REQUIRED, Isaac's alone:**

| # | Question | Options |
|---|---|---|
| C1 | What earns a Tier-1 slot increment? | Per evaluation (→ 40) or per clean payroll cycle (→ 70) |
| C2 | Slot constants: initial 10 / step 10 / cap 100, Tier-2 3→6→10, upgrade at 10 cycles, thresholds 70/40 | Ratify the incumbents or replace them |
| C3 | The auto-approve P(default) cutoff | 0.35 (incumbent) or 0.15 (spec) — or neither until backtested |
| C4 | Which ten conditions gate auto-approval | Spec set (`dias_atraso` / `cartera_vencida`) or shipped set (`activeDefaults` / `age_range`) |
| C5 | Does a competitor loan hard-block, and which lenders count? | Hard block on any / scored / not a condition |

Nothing in the engineering list waits on the commercial list. Items 3, 4, 5, 6 and 8 are
implementable today and would leave the two suites strictly closer to green whichever way
C1–C5 land.

## Consequences

- The suites stay skipped. This ADR does not un-skip anything and does not implement
  anything. ADR-003's exclusion stands until C1–C5 are answered.
- #388 can be reframed from "the tests contradict each other" to "one commercial ruling
  on C1". That is a smaller ask than the issue currently makes it look, and the difference
  matters: it has been blocking on a question that turned out to be a test title.
- #387's second question — "are the specced algorithms still wanted?" — is now answerable
  in pieces rather than all at once. Four of its disagreements have a defensible answer
  that requires no ruling.
- Answering C1–C5 does not by itself ship anything. Finding 2 means the slot subsystem has
  no schema and no enforcement point; the ruling is the cheap part.
- If nothing is decided, the status quo is stable and honest: 150 green, 78 counted in the
  open, and a gate that fails toward human review.

## Alternatives rejected

- **Implement one branch of the `autoScaleTier1` reading and move on.** Rejected in
  ADR-003 for the right reason, and now unnecessary — the function was never the ambiguous
  part. Implementing "flat +10" *inside* the function would have hardcoded a call-site
  policy into a pure helper and broken three unit assertions to satisfy one fixture.
- **Rewrite both specs to match the shipped code and go green.** This is available for
  LTI units and the tier encoding, where the shipped code is demonstrably right. It is not
  available for the fail-open behaviour or the P(default) cutoff, where the shipped code is
  the thing under question. Applying it uniformly would ratify #458 as intended behaviour.
- **Delete both suites.** Same answer as ADR-003. They are the only record the features
  were specified, and Finding 8 shows one of them is the acceptance test for an open bug.
- **Block all ten engineering items behind Isaac's five commercial answers.** That is how
  these two issues have already spent two releases skipped. Separating the two categories
  is the entire point of this document.

## Related

- #387, #388 — the issues this analyses
- #458 — five conditions fail open; Finding 8 is its acceptance test
- #435 — the pay-frequency vocabulary drift that makes option C1-B fragile
- PR #457 — `testPathIgnorePatterns` → `describe.skip`, which made the hole countable
- [[ADR-001-ml-shadow-mode-gate]] — shadow output is logged, not obeyed
- [[ADR-002-fee-rate-single-source-of-truth]] — single server-side definition; the read
  path must not fail open
- [[ADR-003-lending-slot-autoscale-not-implemented]] — the decision this extends
