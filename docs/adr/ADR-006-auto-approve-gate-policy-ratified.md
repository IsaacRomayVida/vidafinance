# ADR-006 — The Stage 3 auto-approve gate policy, ratified

- **Status:** ACCEPTED (policy) — **NOT YET IMPLEMENTED.** The branch carrying the source
  change is red. See §Implementation status.
- **Date:** 2026-08-03
- **Decider:** **Isaac** (every commercial value below); Funpay CTO (engineering shape)
- **Closes:** ADR-005 **C3** (P(default) cutoff) and **C4** (which conditions gate
  auto-approval). ADR-005 **C5** was already ratified separately in #472.
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

### 2. Condition set: retire 9 and 10, add días de atraso and cartera vencida (closes C4)

| id | condition | change |
|---|---|---|
| 9 | `no_active_defaults` | **RETIRED** — a derived count standing in for what the bureau states directly |
| 10 | `age_range` | **RETIRED** — a redundant re-check of a bound Stage 1 already knocks out on |
| — | `dias_atraso_zero` | **ADDED** — bureau's own delinquency-days field |
| — | `cartera_vencida_false` | **ADDED** — bureau's own non-performing flag |

The gate remains ten conditions. Retiring `age_range` does not stop checking age; Stage 1
still knocks out on it, and this row only ever restated that.

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

## Implementation status — NOT DONE

`feat/adr006-gate-policy` (`e065a6d`) carries the source-side change and is **red**:

- 16 guarding tests still assert the pre-ADR-006 shape —
  `stage3-provenance.test.js` (14) and `decision-engine.test.js` (2).
- `stage3-autoapprove.test.js`, the spec this ADR exists to ratify, is **still fully
  `describe.skip`**. The policy change therefore has zero executable coverage.
- Its three `describe`s destructure `runStage3`, `evaluateGate` and `hasCompetitorLoans`;
  the module exports `runAutoApproveGate` and `evaluateAutoApprove`. The spec's *policy*
  disagreements are now resolved by this ADR, but its *API* shape never matched and that
  was never the open question.

## Open — the condition-id conflict

The spec numbers the new conditions **8 (días de atraso), 9 (cartera vencida), 10
(xgboost pdefault)**. The implementation on `e065a6d` numbers them **11 and 12**, keeping
`ml_default_prob` at 8, under an id-permanence rule: retired ids are never reassigned,
because ids are persisted onto loan documents in `underwritingDecision`
(`functions/src/index.ts:625-638`) and recycling one silently rewrites the meaning of
records already written.

Id permanence should win — it is the only option that keeps historical decisions
readable — but it means editing the spec's asserted ids, and that file carries an
explicit "DO NOT make this green by weakening the assertions" warning. Changing an id
convention is not weakening an assertion, so this is judged safe; it is recorded here
rather than done silently because that warning deserves an answer in writing.
