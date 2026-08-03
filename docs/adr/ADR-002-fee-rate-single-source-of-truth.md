# ADR-002 — Fee rate: 30%, behind a single server-side source of truth

- **Status:** ACCEPTED — **RATIFIED BY ISAAC 2026-08-02T05:52Z**
- **Date:** 2026-08-02
- **Decider:** Funpay CTO; ratified by Isaac
- **Authority:** Isaac, 2026-08-02: "get it done now, stop asking me." Then, on being
  shown this ADR: **"Yes 30% but configurable from the admin."**
- **Supersedes:** the open question in `builds/STATUS.md` "Blockers for Isaac #1"

> ## Ratification note (2026-08-02T05:52Z)
>
> Isaac has confirmed **30% is the correct commercial rate**. The `TODO(isaac)`
> at the definition site is resolved — the rate is no longer provisional, and the
> "I am not blessing this pricing" caveat below is superseded on the *value*.
>
> He additionally requires the rate to be **runtime-configurable from the admin
> console**. That is a material change of kind, not just of value: it converts the fee
> rate from a deploy-time constant into a **live lending-control surface**. Tracked as
> **E8**; see "Runtime configurability" below. The single-source-of-truth work in this
> ADR is the prerequisite and remains exactly right — `getLoanConfigValues()` is the
> seam E8 hangs off.

## Context

`main` carries two irreconcilable fee rates for the same loan:

| Location | Rate | Role |
|---|---|---|
| `public-v2/src/pages/LoanWizard.tsx:30` `FEE_RATE = 0.08` | **8%** | shown to the borrower pre-contract |
| `functions/src/index.ts:307` `Math.round(amount * 0.3)` | **30%** | written to the loan document |
| `services/pdf-generator/templates/contract.hbs:42` "Comisión (30%)" | **30%** | the contract the borrower signs |
| `services/pdf-generator/index.js:88-90` CAT derivation | **30%** | the regulated disclosure |

On $1,000 MXN: shown $80, charged $300.

Isaac declined to arbitrate and instructed me to decide. This ADR records the call
and, more importantly, makes it a one-line change to reverse.

## Decision

**The fee rate is 30%.** It moves to a single server-side definition. The frontend and
the contract template both derive from it; neither holds its own constant.

The 8% figure is deleted, not preserved as a fallback. A fallback constant is how this
defect was born.

## Reasoning

1. **30% is what borrowers actually contracted for.** It is in the signed contract PDF
   and in the CAT — the legally operative documents. 8% lives in exactly one place: a
   display constant on a quote screen. Choosing 8% would mean every executed contract
   was wrong. Choosing 30% means only the quote screen was wrong. The smaller lie is
   the one on the screen.
2. **Three of four sources agree on 30%.** The 8% is the outlier, and it is the only
   one with no downstream consumer.
3. **The regulated disclosure is derived from 30%.** Under the CONDUSEF regime the CAT
   and the pre-contractual quote must agree. Aligning the quote *up* to the CAT
   restores that; aligning the CAT *down* to 8% would require re-deriving the regulated
   disclosure on an unratified number — strictly more dangerous.
4. **Reversibility is the real deliverable.** Once there is one definition, changing
   30% → 8% is a single edit plus a deploy. Today it is a four-file archaeology
   exercise. The value of this ADR is mostly that it makes itself cheap to overturn.

## What this is NOT

This is **not** a ratification of 30% as correct pricing. 30% over a 30-day term is
roughly 360% nominal annualised. That is high even by Mexican payroll-advance
standards, and I am not qualified to bless it commercially. It is the *incumbent*
value, and I am refusing to silently reprice live loans in the course of a bug fix.

Isaac can change it in one place, in seconds, whenever he wants. The definition site
carries a `TODO(isaac)` recording that the rate is unratified and that the UI
previously displayed 8%.

## Consequences

- Borrowers now see the price they are actually charged. That is the entire point.
- The displayed price rises 8% → 30% for anyone who saw the old quote screen. Since
  P0-1 means **no loan has ever successfully been created through this flow**, the
  realistic population affected is zero. That should be confirmed, not assumed.
- **Follow-up for counsel (not blocking):** confirm no loan was disbursed under the
  mismatch. If any were, that is a consumer-protection remediation question, not an
  engineering one.

## Alternatives rejected

- **Change `0.08` → `0.3` in the frontend.** Fixes today's symptom, leaves two
  constants that will drift again. This is exactly how the defect arose.
- **Adopt 8% everywhere.** Would contradict every executed contract and force
  re-derivation of a regulated disclosure on an unratified rate.
- **Block on Isaac.** He explicitly declined. Blocking on a decision the decider has
  refused to make is not caution, it is stalling.

## Runtime configurability (E8) — added on Isaac's ratification

The rate becomes editable from the admin console. This is the **highest-stakes knob in
the entire product**: one field, changed by one person, reprices every subsequent loan.
It is Tier-2 (maximum friction) in Funpay Design's danger model, and nothing about it
may be built like an ordinary settings form.

Non-negotiable requirements:

1. **Server-side authorization only.** Write path is a Cloud Function gated on a
   `super_admin`-class claim via `withAuth`. Never a direct client Firestore write, and
   never `firestore.rules` alone. Note `super_admin` currently cannot be granted through
   any API (`functions/src/admin/adminClaims.ts:9-12`) and no bootstrap script exists —
   **E8 must solve that first or the knob is unreachable by anyone.**
2. **Append-only audit trail.** Every change records actor uid, before value, after
   value, timestamp, and a **mandatory free-text reason**. Immutable — no update, no
   delete, enforced in rules. The registry receipts ledger is already hash-chained;
   evaluate reusing it rather than inventing a second audit mechanism.
3. **Two-person approval.** Proposer and approver must be different uids. A single
   compromised or mistaken admin session must not be able to reprice the book.
4. **Bounded range, enforced server-side.** A hard min/max (e.g. 0–35%) rejected by the
   Cloud Function, so a fat-fingered `3.0` cannot mean 300%. Bounds are themselves not
   editable from the console.
5. **Effective-from semantics, never retroactive.** A rate change applies only to loans
   created after it. Loans already written keep the rate they were priced and contracted
   at. Store the rate **on the loan document** at creation so history is reconstructible
   and a later change cannot rewrite what a borrower signed.
6. **Read path must not be able to fail open.** If the config document is missing or
   unreadable, the function throws — it must never silently fall back to a default and
   price a loan at a rate nobody chose. Fail closed, exactly as `requireInternal` should
   have (see P1-4).
7. **The quote and the contract must never diverge again.** The borrower-facing quote,
   the loan document, and the contract PDF/CAT all read the same value for the same
   loan. A regression test asserts all three agree — this ADR exists because they did
   not.

Sequencing: E6 ships the constant behind `getLoanConfigValues()` and unbreaks the loan
flow. E8 then swaps that function's body to read the config document, with the constant
surviving only as the seed value for the initial document. E6 does **not** wait for E8 —
the product is currently unusable and that outranks configurability.

## Related

- `outputs/CRITICAL_DEFECTS.md` — P0-1, P0-2
- [[ADR-001-ml-shadow-mode-gate]] — note that ADR-001's premise was later found not to
  hold; see `outputs/DASHBOARD_DATA_SURFACE.md` §S4
- [[ADR-003-lending-slot-autoscale-not-implemented]]
