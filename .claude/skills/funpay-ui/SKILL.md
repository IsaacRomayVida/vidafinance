---
name: funpay-ui
description: Design and build any FunPay surface — the employee microcredit product of Aliados de Crédito (Mexican SOFOM) — in its established direction. Borrower side (mobile) is cream-to-sage gradient boards, Urbanist plus a dot-matrix label face, pastel green accents, pill controls, botanical photography, one real glass hero. Ops side (lender/employer dashboard) is Blue Charcoal and forest green with Harmony Green active states, frosted folder stacks in 3D perspective, floating glass progress cards. Concept is credit through your job not against it, capture-first, a quiet AI companion that organises after the fact, total cost always in plain sight. Use whenever the user mentions FunPay, Aliados, salary-deducted or payroll microcredit, quincena repayment, a borrower app, an employer or collections dashboard, CONDUSEF disclosures in UI, or wants screens, a landing page, a dashboard, a design system, copy or imagery for this product, or any fintech surface that should match FunPay.
---

# FunPay UI

FunPay is salary-deducted microcredit for hotel employees in Quintana Roo, lent by Aliados de Crédito and repaid a little each *quincena* straight from payroll. This skill is the complete design direction so any agent produces screens that belong to the same product.

**Load order.** Read `references/tokens.css` before writing a line of CSS. Then the reference file for whichever side you are building in `references/components.md`. Read `references/glass.md` only for the hero element. Read `references/copy-and-compliance.md` before writing any copy or any number a borrower sees. `references/imagery.md` when a screen needs a photograph. `assets/reference.html` is a working implementation of every board — open it, lift from it, don't reinvent.

## The concept — everything derives from this

**Credit through your job, not against it.** Not a payday loan, not a card limit. The employer's payroll is the rail; the employee never visits a branch, pledges nothing, and never has a surprise. The design's job is to make that feel true on screen.

Four rules follow:

1. **Capture first.** The first element on a borrower screen is the thing they came to do — the amount with a caret, the request pill, the balance. Never a menu, never a promo, never a chat prompt.
2. **The companion works after.** AI tags the loan purpose, forecasts the next deduction, suggests early payoff — after money exists, never before. It is a card the user opens, never a bar at the top. One sparkle icon in the whole product.
3. **Cost in plain sight.** Total repaid, per-quincena amount, and CAT appear on the same screen as the request, in the same type size as the memo, without a tap. This is the brief's "transparency" and CONDUSEF's requirement at once. Glass is the material because the user should see *through* the tool to their own money.
4. **Simplicity is checkable.** One primary action per screen. At most three visible controls beyond content. Two type sizes plus the label face. One accent per surface. No captions on controls.

## Two sides, one language

| | Borrower (mobile) | Ops (lender / employer dashboard) |
|---|---|---|
| Who | Hotel employee, on a phone, often in Spanish | Aliados operations, employer HR, on desktop |
| Foundation | `--cream` → `--sage` vertical gradient boards on `--void` | `--charcoal` → `--forest` with a green radial glow from the bottom |
| Ink | `--ink #1e201d` | `#f2f5f0` on dark |
| Accent | `--cta #2fc04e`, one control per screen | `--harmony #68e78e`, active/approved states only |
| Glass | Light frosted pills; one Tier 2 transmission hero | Frosted folder stack; floating light-glass progress card; dark glass tags |
| Signature | Blinking caret on the amount | The spatial folder stack with one folder lit |
| Photography | Macro botanical, leaf greens | None — gradient and glass carry it |

They must feel like the same company. Shared: Urbanist, the dot-matrix label face, pill radii, three-stop gradients, the rule that green means *active* and nothing else.

## Borrower side — the screens

Every screen is 9:17, radius `--r-board`, padded 32/28, `display:flex; flex-direction:column`, with `margin-top:auto` pushing the primary content to the lower half where thumbs are.

- **Home** — dot label + avatar top; available credit as the 50px numeral; the active loan as a frosted chip with a progress bar (repaid %, quincenas left); the companion card; filter chips (All / Active / Paid) at the bottom with a count bubble on the active one.
- **Request** — "Repaid from payroll" line, term shown as `12 quincenas · 720 each`, the amount at 64px with a blinking caret, the purpose as a highlighted `<mark>` the companion has tagged, then the disclosure line (total repaid · CAT), then a pill keypad and one green action: `Request 8,000`.
- **Repayment** — amount as the title, term as the quiet second line, a summary that names the employer as the deductor and states early payoff is free, then quincena steps as pills: done (ink, struck through), now (white with shadow), upcoming (paper).
- **Statement / landing** — one big Urbanist headline alternating ink and `--type-quiet` lines, an inline avatar interrupting it, and the capture bar, identity card (employee · employer · lender) floating over it at ±3–6°.
- **Credit line** — the frosted light-glass pass (limit, holder, employer, since) with the specular sweep, and a dark glass sheet below it for one setting.

## Ops side — the dashboard

Two panels in a dark board, `1.25fr 1fr`, collapsing to one column under 820px.

- **Stage panel** — brand mark, dark glass tag pills (Collections · Employers · CONDUSEF), the **spatial stack**: 5–7 frosted folders at `rotateY(-42deg) rotateX(10deg)`, each stepped 118px across and 46px back, a white document peeking from the tab, a count top-right, a label bottom-left rotated −8°. Exactly one folder is lit Harmony Green: the current payroll batch. Above it floats the **progress card** — light glass, rotated −5°, batch name, subtitle, a 40px light-weight percentage, a green dot bottom-right, and a green radial glow leaking into its corner from the lit folder.
- **Data panel** — a live tag, three KPIs (outstanding, active loans, PAR 30), collections by employer as rows with a folder glyph (green when the file is received), a dashed green due-item for the next CONDUSEF filing, and one white action pill.

Folder labels are real objects in the business: employer names, `Quincena 15 Sep`, `AML / PLD`, `SAT`. Never generic "Documents".

## Glass — the inventory

| Element | Recipe |
|---|---|
| Hero balance card | Tier 2 WebGL transmission, `attenuationColor #e4f2e6` — see `glass.md` |
| Filter chips, tag pills | `rgba(255,255,255,.14)` + `blur(14px)`; active goes solid white |
| Loan chip on Home | `rgba(255,255,255,.14)` + `blur(18px) saturate(160%)`, 1px `.22` border, inset top highlight |
| Credit-line pass | `rgba(255,255,255,.34)` + `blur(26px) saturate(170%)`, `.55` border, specular sweep pseudo-element |
| Dark sheet | `rgba(20,24,20,.72)` + `blur(26px) saturate(150%)`, `.1` border |
| Ops folders | `rgba(255,255,255,.13)` + `blur(10px) saturate(140%)`, `.28` border; lit = `rgba(104,231,142,.55)` |
| Ops progress card | `rgba(255,255,255,.52)` + `blur(22px) saturate(160%)`, `.7` border, green screen-blend glow |
| Companion / identity cards | Acetate — three-stop pastel gradient, no blur |

One Tier 2 element per view. Never nest `backdrop-filter`. Never glass over a flat colour.

## Typography

- **Urbanist** for everything read. Numerals are the hero: 50–64px, weight 400, tracking −0.03 to −0.04em, currency as a 20–22px light suffix. Body 13–15px, weight 300–400. Headlines alternate weight 400 ink and weight 300 `--type-quiet`.
- **Doto** (open stand-in for Matricha) for labels only: uppercase, 600, +6% tracking, muted. Screen names, `FUNPAY`, `PAYROLL · 15 SEP`. Never a sentence, never a button.

## Colour

Load tokens; do not retype. Green is semantic: it means active, approved, received, current. It never decorates. On cream the accent is `--cta`; on charcoal it is `--harmony`. `--mark` (pale mint) is the highlighter for companion-tagged text with `--mark-ink` for its count bubbles. Gradients are three-stop diagonals between adjacent pastels. Ink is never `#000`.

## Motion

Caret blinks at 1.1s `steps(2)`. Hero backdrop drifts on 17–26s sine loops and follows the pointer with 0.06 lerp. Nothing else moves. `prefers-reduced-motion` stops drift entirely.

## Anti-patterns — reject on sight

- A chat prompt or search bar as the first element
- Sparkle icons on more than one control
- Green used as decoration, or two greens on one surface
- A percentage, rate, or total the borrower can't see without tapping
- Rectangles with radius under 18px; drop shadows on flat elements
- Dot-matrix type in body copy or buttons
- Stock photography, faces in focus, saturated flowers
- "Loan", "debt", "interest" in headline copy — see `copy-and-compliance.md`
- English-only copy shipped to borrowers

## Workflow

1. Read `tokens.css`; paste it as `:root`.
2. Decide the side. Borrower → cream boards, one Tier 2 hero. Ops → dark board, folder stack, no WebGL.
3. Open `assets/reference.html`, find the nearest board, copy its structure.
4. Write copy from `copy-and-compliance.md`; every borrower number gets its disclosure line.
5. Run the anti-pattern list. Remove what matches.
6. Deliver as a single HTML file unless asked otherwise; keep fonts on Google Fonts and three.js on jsDelivr so it runs anywhere.
