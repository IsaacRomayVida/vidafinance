---
name: component-audit
description: Audit a React component against VIDA's design system, accessibility, and code conventions. Invoke when user asks "review this component", "audit X", "is this up to standard". Produces a structured findings list with file:line references and fixes.
---

# Component Audit

Audit a specified component (or active file) across 6 dimensions. Output a structured report.

## Ask once if not provided

- Which file to audit? (path or component name — resolve name against `public-v2/src/**/*.tsx`)

## Dimensions

### 1. Design system compliance (rule 02)

- Hard-coded colors (`#XXXXXX` in className or style) instead of `bg-teal-*` / `bg-gold-*` / legacy `var(--brand)` etc.
- Using `bg-vida-teal` or similar non-existent classes
- Hard-coded `font-size: 18px` in inline style (should be Tailwind util or `@theme` token)
- Arbitrary spacing like `mt-[17px]` — should use the 4px grid (`mt-4`, `mt-5`)
- Fonts other than DM Sans (body) or DM Serif Display (headings) inlined
- Emoji used as icons (legacy debt — don't add more)
- `text-align: center` on body paragraphs
- Fixed heights on text containers

### 2. Accessibility (rule 02 + 05)

- Interactive elements missing `focus-visible:` styles
- Images without `alt` (decorative needs explicit `alt=""`)
- Icon-only buttons without `aria-label`
- Form inputs without `<label>` or `aria-label`
- Color-only status (green check without text/icon)
- Custom clickable `<div>` instead of `<button>`
- Nested interactive elements (`<button>` inside `<a>`)
- Missing `lang` on foreign-language content
- Manual `tabIndex > 0`

### 3. React conventions (rule 03)

- `React.FC` usage
- Default exports on pages (breaks lazy-load pattern in App.tsx)
- `any` types
- Props interface > 10 properties
- `useEffect` without cleanup on subscriptions
- State mutation (`array.push()` instead of `setArray([...array, x])`)
- Components > 250 lines
- Prop drilling > 2 levels
- Direct `localStorage` / `window` usage (only allowed case: `vida_lang` in i18n/index.ts)

### 4. Firebase patterns (rule 04)

- `getDoc` / `onSnapshot` in component body (should be in a hook)
- Manual `fetch()` to CF endpoints (should be `httpsCallable`)
- `initializeApp` outside `lib/firebase.ts`
- Direct writes to protected collections
- `dangerouslySetInnerHTML` with CF-returned data (only acceptable for i18n `<em>` strings)

### 5. Spanish copy (rule 06)

- "Usted" instead of "tú"
- Title Case in Spanish button labels
- Missing `¿` or `¡`
- "Haz clic aquí" links
- Emoji in UI copy
- Peso amounts without `$`/commas/tabular-nums
- English words where Spanish exists
- Sentences > 16 words
- Generic "Algo salió mal" where specific is possible
- Hard-coded strings that should be in `es.json` + `en.json`

### 6. Performance

- Images without `loading="lazy"` (below fold) + `width`/`height`
- Heavy libraries imported but used minimally
- `React.memo` cargo-culted
- Unstable `useEffect` deps (running every render)
- Unvirtualized lists > 50 items
- Synchronous expensive computations in render

## Output format

```markdown
# Audit: <ComponentName>

**File:** `<path>`
**Lines:** <total>
**Overall:** PASS | PARTIAL | NEEDS WORK

## Summary
<2-3 sentences — strong, weak, verdict>

## Findings

### 🔴 Must fix before merging
1. **[Dimension] Title** — `file.tsx:42`
   - Problem: <one sentence>
   - Fix:
     ```tsx
     // suggested replacement
     ```

### 🟡 Should fix
1. ...

### 🔵 Consider
1. ...

## What's done well
- <positives — reinforce good patterns>

## Suggested PR description
<3-5 lines ready to paste>
```

## Rules

- **Cite file:line for every finding** when possible
- **Suggest a fix, not just a problem**
- **Don't nitpick.** Focus on things that matter. Style preference → severity "low", rarely
- **Don't recommend wholesale rewrites** unless truly warranted. If so, say so in summary and stop detail audit
- **Keep under 500 lines of output.** > 15 findings = consolidate or recommend a split
- **Respect existing patterns.** If the repo has a convention that differs from rule 03 (e.g. named exports), flag it as a rule gap and mention in summary, don't critique the component for following the repo

## Don't audit

- Generated files
- Third-party code
- Test files unless asked
- Config files unless the audit target IS a config
