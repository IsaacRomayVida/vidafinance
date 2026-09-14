# Copy and compliance

FunPay copy is short, declarative, and never sells. The compliance rules here are design constraints, not legal advice: they say *where* and *how* required information appears so it reads as part of the product rather than a footnote. Aliados' compliance officer owns the exact wording and figures.

## Voice

- **Say what happens, not what it means.** `Repaid from payroll` beats `Hassle-free repayment`. `720 each quincena` beats `affordable instalments`.
- **No exclamation marks. No greetings from the companion.** It never says hello; it states a fact or makes an offer.
- **Numbers are the copy.** The amount, the per-quincena figure, the total repaid, the CAT. Words exist to label numbers.
- **One verb per control.** `Request 8,000`. `Run 30 Sep batch`. `Freeze`. Never `Click here to…`.
- **Headline vocabulary.** Use *credit*, *advance*, *fund*, *repaid*, *quincena*, *payroll*, *employer*. Avoid *loan*, *debt*, *borrow*, *interest* in headlines and buttons; they may appear in disclosure lines where precision requires them (`Loan · 8,000 MXN` is fine as a data label).
- **The employer is named.** `Deducted by Xcaret Arte` — the borrower should always know who takes the money and when.
- **Early payoff is always mentioned next to the term.** `Pay the rest early any time, no fee.` If it isn't free, say what it costs in the same sentence.

## Companion phrasing

Suggestions are chips of 4–7 words, in three kinds only:

| Kind | Example |
|---|---|
| Next fact | `Next deduction: 720 on 15 Sep` |
| Offer with the saving stated | `Pay 1,500 early, save 210` |
| Explain a number | `Why is my limit 12,000` |

The input placeholder is `Ask anything about your credit…`. Never `How can I help you today?`.

## Language

Borrowers are hotel staff in Quintana Roo. **Ship Spanish first; English is the mockup language.** When producing production copy, write Spanish (`es-MX`) and keep these product terms untranslated in both: *quincena*, *CAT*, *FunPay*, employer names. Formal *usted* register is not required; use neutral second-person *tú* consistently, as Mexican fintech apps do. Dates as `15 sep`, amounts as `8,000 MXN` with a comma thousands separator and no decimals unless cents matter.

## Disclosure placement — the design rule

Every borrower screen that shows a request, an offer, or an active credit must show, **on the same screen, without a tap, at 13px or larger**:

1. The total amount to be repaid over the term
2. The per-quincena deduction
3. The CAT, labelled as informational, and its basis (with or without VAT — *sin IVA* / *con IVA*) exactly as the compliance officer specifies

Reference format from the mockup: `Total cost in plain sight: 8,640 repaid · CAT 38.5% informational`. The figure in the mockup is a placeholder. **Never invent, round, or restate a rate**; take it from the product configuration and render it as given. If the rate is unavailable, render the line with the value missing and flag it, rather than omitting the line.

This placement is the concept ("cost in plain sight") doing the regulator's work. It is not optional, not collapsible, and not smaller than the memo above it.

## Ops-side vocabulary

Folders and rows are named after real objects in the operation: employer names, `Quincena 15 Sep`, `AML / PLD`, `SAT`, `CONDUSEF`. Status words are limited to `file received`, `file pending`, `n leavers flagged`, `sections ready`. KPIs are `Outstanding`, `Active loans`, `PAR 30`. Green means received/approved/current and nothing else.

## Things copy never does

- Promise approval, speed, or "instant" anything
- Compare to other lenders
- Use emoji
- Call the companion an "AI" in borrower-facing text; it's the companion, or unnamed
- Put a legal paragraph on a screen — disclosures are one line in the product's own type; long text lives on a dedicated page linked from Settings
