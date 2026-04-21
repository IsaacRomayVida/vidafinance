---
name: mobile-first-polish
description: Make a component or page fully responsive the right way — mobile-first, breakpoint by breakpoint. Invoke for "make this responsive", "polish for mobile", "broken on my phone". Checks 4 viewports, fixes overflow, ensures tap targets, verifies no layout shift.
---

# Mobile-First Polish

Turn desktop-centric components into ones that feel native on Mexican Android phones (majority of VIDA users).

## Ask once

- Which component/page?
- Any known issues? (e.g. "the CTA breaks at 360px")

## Canonical viewports

| Name | Dimensions | Why |
|---|---|---|
| Small phone | 360×780 | Majority of VIDA users — low-end Android |
| Large phone | 393×852 | iPhone 14/15, Pixel 7 |
| Tablet | 768×1024 | iPad, employer admins on tablets |
| Desktop | 1440×900 | Employer admins, ops team |

## Workflow

### 1. Diagnose

Read the file. Report in 3-5 bullets:
- Current CSS approach (Tailwind utilities, legacy.css, inline, mixed)
- Breakpoints in use (`sm:` `md:` `lg:` prefixes)
- Hard-coded dimensions (pixel widths, fixed heights)
- Overflow risks (long words, images without max-width, tables)
- Tap target sizes (< 44×44 is too small)

### 2. Layout plan per breakpoint

| Breakpoint | Decision |
|---|---|
| base (360px) | Single column, stacked. Full-width primary CTAs. Text ≤ 16px base. Padding `px-4 py-6`. |
| sm (640px+) | 2-col only if content pairs naturally |
| md (768px+) | Tablet — denser info OK. Sidebar if dashboard |
| lg (1024px+) | Desktop — side-by-side sections. Max-width containers |
| xl (1280px+) | Stop scaling, cap at `max-w-7xl` for readability |

### 3. Apply fixes mobile-first

Base styles for 360px, then progressively enhance. **Never the reverse:**

```tsx
// ❌
<div className="flex flex-row gap-8 p-16 max-lg:flex-col max-lg:gap-4">

// ✅
<div className="flex flex-col gap-4 p-4 md:flex-row md:gap-8 md:p-16">
```

### 4. Specific fixes

**Typography:**
- Replace fixed `text-2xl` with `text-xl md:text-2xl` if it doesn't fit at 360px
- For fluid sizing use Tailwind arbitrary: `text-[clamp(2.25rem,1.9rem+1.75vw,3.25rem)]`

**Spacing:**
- Section padding: `px-4 py-8 md:px-8 md:py-16`
- Card padding: `p-4 md:p-6` (never < `p-4`)
- Stack gap: `gap-4 md:gap-6`
- Legacy `.wrap` class uses `padding: 0 64px` — don't mix systems; use Tailwind throughout a new block

**Images:**
- `loading="lazy"` unless above-fold critical
- Explicit `width` + `height` to prevent CLS
- `max-width: 100%; height: auto` on content images
- Prefer `<picture>` with WebP + JPG fallback for hero

**Buttons:**
- Primary CTA: `w-full sm:w-auto` on mobile
- Min tap target `h-11 px-5` (44px height)
- Never 2 primary buttons side-by-side on mobile — stack

**Tables:**
- Tables don't work on phones. Convert to stacked cards below `md:`:
  ```tsx
  <div className="md:hidden">{/* cards */}</div>
  <table className="hidden md:table">{/* table */}</table>
  ```
- Or horizontal scroll with `overflow-x-auto` if the table IS the content

**Forms:**
- Inputs full-width on mobile (`w-full`)
- `space-y-4` between fields
- Long forms → multi-step, not one scrolling page
- Labels above inputs

**Navigation:**
- Hamburger below `md:` — the existing Navbar.tsx has this pattern
- Sticky header OK; don't double-stick top AND bottom

**Overflow:**
- `overflow-x: hidden` on body is a band-aid — fix the offending element
- Long URLs / CURPs: `break-words` or `break-all`

### 5. Verify

```bash
cd public-v2 && npm run dev
# Open http://localhost:3000/<route>
# DevTools → Device Toolbar → test 360×780, 393×852, 768×1024, 1440×900
# Look for: horizontal scrollbar (bug), cut-off text, overlapping elements, tiny taps
```

### 6. Output

Return:

1. **Summary** — what changed and why
2. **Diff** of key changes (not full file)
3. **Verification checklist** — what Isaac should eyeball at each viewport
4. **Follow-up notes** — deferred issues ("testimonial carousel needs touch-swipe — separate ticket?")

## Checklist before done

- [ ] Zero horizontal overflow at 360px
- [ ] All interactive elements ≥ 44×44
- [ ] Text ≥ 14px, 16px body preferred
- [ ] Images have width + height
- [ ] Tailwind classes mobile-first (no `max-*:`)
- [ ] No fixed heights on text containers
- [ ] No desktop-only interactions (hover-reveal has touch equivalent)
- [ ] Contrast WCAG AA at all breakpoints
- [ ] `cd public-v2 && npm run build` passes

## Anti-patterns

- **"Works at 390px"** — check 360px. Low-end Androids are narrower.
- **Hiding on mobile** (`md:hidden`) what's important. If important, redesign for mobile; don't delete.
- **Floats and negative margins** for mobile layout. Use flexbox or grid.
- **`100vw`** — scrollbar eats width on desktop; use `100%` on block elements.
- **`100vh` on mobile** — iOS Safari's address bar breaks this. Use `100dvh` or `min-height: 100vh`.
