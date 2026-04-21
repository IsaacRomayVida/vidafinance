---
name: ship-component
description: Full build-test-verify-PR workflow for a new or modified React component. Walks through design alignment, coding, responsive testing, a11y check, commit, PR opening. Use when starting or finishing component-scope work.
---

# /ship-component

End-to-end workflow producing a PR ready to merge without follow-up.

## Ask once at the start

1. **What's the component?** (name + 1-sentence purpose)
2. **New or modifying existing?**
3. **Linear ticket?** (VID3-XXX) — for commit and PR. No ticket → ask if we create one first.

Answers unclear → don't proceed, ask.

## Workflow

### Phase 1 — Plan

Before writing code:

1. Re-read `.cursor/rules/02-frontend-design-system.md` for relevant patterns
2. Search for prior art: `grep -rn "<component name>" public-v2/src/` — don't duplicate
3. Draft props interface. Output it as proposed contract.
4. Identify dependencies. New npm package? Justify per rule 05 invariant 12.

Output 3-5 bullet plan. Pause for Isaac to confirm.

### Phase 2 — Implement

1. Create file at right location:
   - Shared → `public-v2/src/components/<Name>.tsx`
   - Page-specific → under `public-v2/src/pages/<PageName>/<Sub>.tsx`
   - Marketing section → `public-v2/src/components/marketing/<Name>.tsx`
   - Layout → already sufficient layouts exist, don't add
2. Follow rule 03:
   - **Named export** (not default — pages lazy-load via `.then(m => ({ default: m.X }))`)
   - No `React.FC`
   - Discriminated unions for variants
   - TypeScript strict
3. Style with Tailwind utilities + real tokens (`bg-teal-900`, not `bg-vida-teal`)
4. Use `useTranslation` for user-facing strings; add keys to `es.json` AND `en.json`

### Phase 3 — Wire

If component reads/writes data:
1. Use existing hook if possible (`useAuth` already exists)
2. Create a new hook in `src/hooks/` if needed — don't fetch in component body
3. Wrap CFs with typed `httpsCallable<Input, Output>`
4. Handle loading + error + empty. All three.

### Phase 4 — Test locally

```bash
cd public-v2 && npm run dev
```

Opens `http://localhost:3000` (NOT 5173). Verify at 4 viewports:
- 360×780 (small Android)
- 393×852 (iPhone 14)
- 768×1024 (tablet)
- 1440×900 (desktop)

Checklist:
- [ ] Zero horizontal overflow at any viewport
- [ ] Tap targets ≥ 44×44
- [ ] Keyboard nav (Tab, Enter/Space, Esc)
- [ ] Focus rings visible
- [ ] No console errors/warnings
- [ ] Loading state on slow network (DevTools → Network → Slow 3G)
- [ ] Error state tested (force-throw in hook)
- [ ] Empty state tested (mock empty data)

### Phase 5 — Check integration

```bash
cd public-v2 && npm run build
```

Must pass cleanly. `tsc && vite build` — type errors fail the build.

If functions/ touched (unusual for frontend task):
```bash
cd functions && npm test
```

### Phase 6 — Commit

Conventional commits, scoped:

```
feat(public-v2): <short description> (VID3-XXX)

<2-3 lines — what this enables, why done this way>

Refs VID3-XXX
```

**Types:** `feat`, `fix`, `refactor`, `style`, `chore`.
**Scope:** `public-v2` for frontend.

### Phase 7 — Open PR

```bash
git push -u origin <branch>
gh pr create --title "feat(public-v2): <title> (VID3-XXX)" --body "$(cat <<'EOF'
## Summary
<1-2 sentences>

## Screenshots
<before/after — 2-3 viewports: mobile + desktop minimum>

## Changes
- <bullets of notable changes>

## Verification
- [x] Builds cleanly (`npm run build`)
- [x] Verified at 360, 393, 768, 1440 viewports
- [x] Keyboard nav tested
- [x] Loading + error + empty states tested
- [x] No console warnings

## Linear
Refs VID3-XXX
EOF
)"
```

Screenshots from Chrome DevTools at the 4 viewports.

### Phase 8 — Self-review

Run `/review-pr` — catches what you miss after staring at your own diff.

## When to stop and ask

- Design unspecified + implementation making many guesses → stop, ask for specifics
- CF needed that doesn't exist → stop. Opening a CF is a separate ticket.
- Touching > 10 files → reconsider scope. Probably too broad.
- Tests breaking unexpectedly → diagnose before paper-over.

## Scope discipline

A "component" PR touches:
- 1 new or modified component file
- Its hook (if new)
- Maybe 1-2 adjacent files (parent using it, type file)
- i18n keys in es.json + en.json

If your PR touches `firebase.ts`, `tailwind.config`, 3 CSS files, and a CF — scoped wrong. Split.
