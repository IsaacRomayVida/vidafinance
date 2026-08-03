# ADR-006 — The Stage 3 auto-approve gate policy, ratified

- **Status:** ACCEPTED (policy) and **IMPLEMENTED** — the gate now runs twelve conditions
  at a 0.15 cutoff, package green. See §Implementation status.
- **Date:** 2026-08-03
- **Decider:** **Isaac** (every commercial value below); Funpay CTO (engineering shape)
- **Closes:** ADR-005 **C3** (P(default) cutoff). ADR-005 **C5** was already ratified
  separately in #472. **C4** (which conditions gate auto-approval) is *not* closed here —
  see §2; it stays open pending Isaac.
- **Supersedes:** the `SEED_MAX_PDEFAULT = 0.35` incumbent recorded in ADR-005 C3.

## Context

ADR-005 separated what engineering may settle from what only the founder may, and left
five commercial questions (C1–C5) open. Two of them governed the Stage 3 auto-approve
gate, and both were blocking: the gate cannot be specified without them, and
`src/stages/__tests__/stage3-autoapprove.test.js` — the only surviving record of the
intended ten-condition gate — has been fully `describe.skip` since #457 precisely
because nobody could say which of its disagreements with the shipped code was right.

Isaac answered both by voice on 2026-08-03. This ADR records the answers, and one
finding that materially changes what they are worth.

## Decision

### 1. P(default) cutoff → 0.15 (closes C3)

`SEED_MAX_PDEFAULT` moves from **0.35** to **0.15**.

> "So question 1, put it at the lower threshold of 0.15."
> — Isaac, 2026-08-03 08:20:34Z; reconfirmed 09:11:18Z ("let's make it the default
> probability at 0.15").

0.15 is the number the never-executed spec always carried; 0.35 was an artefact of
`1 − APPROVAL_THRESHOLD` and was never chosen by anyone. The direction is conservative:
the cutoff is the *maximum* modelled default probability that still auto-approves, so
lowering it can only push cases toward human review, never toward lending. That is the
correct asymmetry while the model producing pDefault is unbacktested (ADR-001 §Follow-up).

This value lives behind the ADR-002 server-config seam (`config/maxPDefaultCutoff.js`,
landed in #473), so the constant is only the fresh-environment seed — production is
changed by writing the config document, not by deploying this number.

### 2. Condition set: add días de atraso and cartera vencida. C4 stays OPEN.

| id | condition | change |
|---|---|---|
| 9 | `no_active_defaults` | **UNCHANGED — still live.** Retirement proposed, not ratified. |
| 10 | `age_range` | **UNCHANGED — still live.** Retirement proposed, not ratified. |
| 11 | `dias_atraso_zero` | **ADDED** — bureau's own delinquency-days field |
| 12 | `cartera_vencida_false` | **ADDED** — bureau's own non-performing flag |

**The gate goes from ten conditions to twelve.** An earlier draft of this ADR recorded C4
as closed, with ids 9 and 10 retired in favour of the two additions. That was withdrawn on
review, for a reason worth stating plainly:

Sections 1 and 3 of this ADR each quote Isaac verbatim. This section quoted nobody. The
only thing Isaac said about the underlying question was *"Four. Explain to me question
four. I don't get it."* (2026-08-03 08:12:38Z) — and no later message answers it. His
09:11:18Z ruling covers three items (the per-review cap, the 0.15 cutoff, the competitor
list) and does not reach this one. So C4 was never ratified; it was inferred.

The inference is defensible on the merits — `age_range` genuinely does restate a bound
Stage 1 already enforces, and `no_active_defaults` is a derived count where the bureau
now states the underlying facts directly. But **retiring a condition loosens the gate**:
fewer conditions must hold, so strictly more applicants auto-approve. That is a
credit-policy loosening, and a loosening is exactly the class of change engineering may
not adopt by inference. Adding 11 and 12 while keeping 9 and 10 moves in the only
direction that is safe to take unilaterally — the gate tightens.

**C4 therefore remains OPEN and is flagged back to Isaac**: should `no_active_defaults`
and `age_range` be retired now that días de atraso and cartera vencida are read directly?
Until he rules, both stay live and their ids stay assigned.

### 3. Competitor list: the seeded list is ratified as-is, and must stay admin-editable

> "In terms of three, yes, for now, leave those and make it easy for us to add, maybe from
> the admin panel or somewhere else, to add additional competitors."
> — Isaac, 2026-08-03 09:11:18Z

KUESKI / MoneyMan / CREDITEA stand. The Firestore seam from #472 already satisfies the
editability requirement at the data layer; an admin-panel surface for it is **follow-up
work, not yet built.**

Consequently, condition 5 (`no_competitor_loans`) is rewired to read the named-match
signal (`competitorLoansByName`) rather than SoftCrédito's opaque `competitor_loans`
count. This does not change the condition's *effect* — per C5 (#472) a competitor loan
blocks auto-approval and routes to a human; it is never a decline. Only which signal
decides it changed.

## The finding that limits all of the above

**Condition 8 currently fails for 100% of applicants, and 0.15 does not change that.**
Verified against both sides of the wire on this branch:

- `services/ml-service/main.py:485-494` — `POST /score` returns `decision`,
  `championScore`, `challengerScore`, `threshold`, `championModel`, `challengerModel`,
  `shapTop5`.
- `services/underwriting-service/src/stages/stage3-autoapprove.js` — condition 8 reads
  `mlScore?.default_probability || mlScore?.probability || (1 - (mlScore?.underwritingScore || 0.5))`.

None of those three field names exists in the response. Every term falls through and
pDefault resolves to a hardcoded `1 − 0.5 = 0.5`. `0.5 < 0.35` is false and `0.5 < 0.15`
is equally false, so condition 8 never passes, `allPass` is never true, and **no
application has ever been auto-approved by this gate.** Every one escalates to Stage 4.

So the cutoff ratified here is, today, an inert number. It binds nothing until the
contract is fixed. Fixing it is **not** a field rename: `championScore` is a score, and
whether it is a default probability, its complement, or a differently-scaled value has to
be read off `ModelRouter.predict` before anything is wired to it. Getting the polarity
wrong here inverts the gate — it would auto-approve exactly the applicants it should
escalate — which is why this ADR stops at recording the defect rather than guessing.

This supersedes the C3 section of `outputs/Funpay_Underwriting_Pipeline_2026-08-03.pdf`,
which was generated before the ratification and still reads "ratify neither number yet".

## Implementation status — DONE and green

`feat/adr006-gate-policy` carries the source-side change. The 16 guarding tests that
asserted the pre-ADR-006 shape have been reconciled and the package is green:

```
Test Suites: 1 skipped, 18 passed, 18 of 19 total
Tests:       61 skipped, 274 passed, 335 total
```

Each reconciled assertion was judged individually rather than relaxed to fit:

- The `ALL_DATA_PRESENT` fixture's `default_probability` moved 0.18 → 0.12. 0.18 is a
  *declining* value under the ratified 0.15 cutoff, so it could no longer stand for "every
  condition passes".
- The shadow-challenger test got **stronger**, not weaker. Champion 0.18 now declines while
  the shadow 0.01 would pass, so `pass === false` is itself proof the challenger was not
  read; previously both cleared 0.35 and only the pinned `value` carried the argument.
- Condition 5's `source` was corrected back to `"assumed"` when the bureau block is
  absent. The draft marked it `"read"` — reasoning that "no account list" means "no
  competitor accounts found" — which would have made the fail-closed invariant universal
  by *defining away* its one exception. Nothing was read there, and relabelling an absence
  as a measurement is precisely the #458 failure this file exists to prevent. The
  exception stays visible and narrow.

Still outstanding, and unchanged by this work:

- `stage3-autoapprove.test.js`, the spec this ADR exists to ratify, is **still fully
  `describe.skip`**. The ratified policy therefore has coverage from the provenance and
  decision-engine suites, but the spec file itself remains unexecuted.
- Its three `describe`s destructure `runStage3`, `evaluateGate` and `hasCompetitorLoans`;
  the module exports `runAutoApproveGate` and `evaluateAutoApprove`. The spec's *policy*
  disagreements are now resolved by this ADR, but its *API* shape never matched and that
  was never the open question.

## Open — the condition-id conflict

The spec numbers the new conditions **8 (días de atraso), 9 (cartera vencida), 10
(xgboost pdefault)**. The implementation numbers them **11 and 12**, keeping
`ml_default_prob` at 8, under an id-permanence rule: assigned ids are never reassigned —
and since §2 keeps 9 and 10 live, those numbers are not free to take in any case,
because ids are persisted onto loan documents in `underwritingDecision`
(`functions/src/index.ts:625-638`) and recycling one silently rewrites the meaning of
records already written.

Id permanence should win — it is the only option that keeps historical decisions
readable — but it means editing the spec's asserted ids, and that file carries an
explicit "DO NOT make this green by weakening the assertions" warning. Changing an id
convention is not weakening an assertion, so this is judged safe; it is recorded here
rather than done silently because that warning deserves an answer in writing.
