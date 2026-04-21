---
name: polish-page
description: Full audit and polish pass on an existing page — design, copy, accessibility, performance. Invoke for "make X look good", "the dashboard needs work", "polish the onboarding flow". Produces a prioritized list and executes the top-priority ones.
---

# /polish-page

Structured polish pass on a complete page or user flow, not a single component. For when you have a working but rough-feeling page and want production quality.

## Ask at the start

1. **Which page?** (route like `/employer/payroll`, or path to the page file)
2. **Known issues?** (things Isaac already spotted)
3. **Scope:** full polish (60-90 min) or quick-hit (15 min)?
4. **Linear ticket?** — for commits/PR

## The pipeline

### Pass 1 — Audit (read-only)

Run the `component-audit` skill on the page component AND its major children (marketing sections, layout wrappers, data-driven children). Collect findings across:

- Design system compliance
- Accessibility
- React conventions
- Firebase patterns
- Spanish copy
- Performance

Also invoke `@design-critic` on the visual result. Best way: open the page in Cursor's browser preview, or have Isaac share screenshots at 360px + 1440px.

Consolidate into one prioritized list:

| Priority | Definition |
|---|---|
| 🔴 Must fix | Breaks the page at some viewport / user / interaction; a11y violation; wrong data |
| 🟡 Should fix | Noticeable quality gap; slightly off design system; awkward copy |
| 🔵 Consider | Stylistic preference; nice-to-have refinement |

### Pass 2 — Plan

Present list to Isaac with time estimates. Example:

```
Polish pass on /employer — 14 findings:

🔴 Must fix (3 items, ~25 min):
1. Empty state has no guidance text (EmployerDashboard.tsx:28)
2. Error state missing ARIA live region (EmployerDashboard.tsx:91)
3. Loan amounts not tabular-nums — misaligns (LoanStatusCard.tsx:44)

🟡 Should fix (7 items, ~45 min):
4. Section padding tight at 768px (EmployerDashboard.tsx:20)
5. "Submit" English verb in button — should be "Enviar" (ContactForm.tsx:67)
...

🔵 Consider (4 items, ~20 min):
12. Animate card hover — currently abrupt
...

Total if all: ~90 min. Want me to do 🔴+🟡 (~70 min) and skip 🔵?
```

Wait for go-ahead. Respect scope if quick-hit requested.

### Pass 3 — Execute

Apply fixes in priority order. Per fix:
1. Make the change
2. Verify at the viewport where it matters
3. Move on

Don't rewrite unrelated code. Don't "improve" code not in findings.

After all approved fixes:
1. `cd public-v2 && npm run build` — must pass clean
2. `npm run dev` — manually verify at 4 viewports (`http://localhost:3000`)
3. Spot-check keyboard nav

### Pass 4 — Document

Commit:

```
style(public-v2): polish <page-name> (VID3-XXX)

- Fix empty state guidance
- Fix ARIA live region on error
- Use tabular-nums on amounts
- Fix section padding at 768px
- Rewrite submit CTA to Spanish verb
- <etc. — one line per change>

Refs VID3-XXX
```

Open PR with before/after screenshots for notable visual changes.

## Boundary conditions

**Polish pass DOES:**
- Design system alignment
- Copy refinement (via i18n — update `es.json` + `en.json`)
- Accessibility fixes
- Responsive tweaks
- Performance micro-optimizations (lazy-load, dimension attrs)
- Tightening loading/error/empty states

**Polish pass does NOT:**
- Add new features (out of scope — open a new ticket)
- Restructure data fetching (separate refactor ticket)
- Introduce new dependencies
- Change routing/navigation
- Modify Cloud Functions or Firestore rules
- Wholesale rewrites (if component needs rewrite, say so and STOP — don't sneak it into polish)

## Common polish wins (check even if unflagged)

- `<html lang>` set via i18n (already wired in `src/i18n/index.ts`)
- `<title>` per page via `useDocumentTitle` or `react-helmet-async`
- Meta description for SEO pages (landing, employers)
- OG image tags for shareable pages
- Lazy-load offscreen images
- `width`/`height` on all images
- `tabular-nums` on all money
- `focus-visible:` styles everywhere interactive
- Empty state messaging (teach, don't just announce)
- Error state specificity
- Success state confirmation

## Anti-patterns

- ❌ Changing colors "to make it pop" — use `teal-*` / `gold-*`
- ❌ Adding shadows/borders decoratively
- ❌ Gradient backgrounds
- ❌ Custom animations on every element
- ❌ Emoji in copy
- ❌ Bumping font-size past the scale
- ❌ Removing labels to "clean up" forms
- ❌ Introducing carousels that weren't there

## Output when complete

```markdown
# Polish complete: <page>

## Changes
- <bullets>

## Before/After
<screenshots or descriptions>

## Not done (deferred)
- <audit findings out of scope>
- <recommended follow-up tickets>

## Verification checklist
- [x] Builds clean
- [x] 360px verified
- [x] 393px verified
- [x] 768px verified
- [x] 1440px verified
- [x] Keyboard nav works
- [x] No console warnings
```
