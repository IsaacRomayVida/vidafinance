---
name: frontend-debug
description: Diagnose visual, layout, or behavior bugs in public-v2. Invoke for specific defects — "hero overflows on mobile", "button doesn't submit", "CF returns 401", "loan status stale", "modal does nothing". Produces root-cause analysis with targeted fix.
---

# Frontend Debug

Diagnose a specific problem. Goal is root cause, not band-aid.

## Ask once if not provided

- **What's broken?** — Specific symptom + repro steps
- **Where?** — Route, component, viewport, user role
- **When did it start?** — Fresh, regression, or always?
- **Console errors / network failures?** — Paste if so

Don't start without a clear symptom. "It doesn't work" is not enough.

## By category

### A — Layout / visual bugs

**Diagnose:**

1. What viewport? Try 360, 768, 1440
2. Regression? `git log -p <file>`
3. Prod or local only? (cache?)
4. CSS cascade fight? `styles/index.css` vs `styles/legacy.css` vs inline Tailwind?

**Investigation:**

1. Read the component end-to-end
2. Grep both CSS files for selectors affecting this element: `grep -rn ".classname" public-v2/src/styles/`
3. DevTools → computed styles → which declaration wins?
4. Check parent constraints (overflow, height, flex)

**Common root causes:**

| Symptom | Likely cause |
|---|---|
| Horizontal overflow at 360px | Fixed width, long unbreakable text, negative margin, `min-width` on child |
| Element invisible | `display:none` via responsive class, z-index stacking, opacity:0, color matches bg |
| Wrong font | Missing `@font-face`, CDN failure, fallback kicking in (e.g. DM Sans not loading) |
| Styles not applying | Tailwind v4 purged a class (dynamic name like `bg-${color}`) — Tailwind can't analyze it |
| Layout shift on load | Images without dimensions, fonts loading without `font-display:swap`, content injected post-render |
| Flex sizes wrong | Missing `flex-shrink: 0` when needed, `min-width: auto` on flex children |

### B — Interactive / behavior

**Diagnose:**

1. Handler fires? (`console.log` at top)
2. `event.preventDefault()` missing or extra?
3. Element disabled (validation state)?
4. Overlay / z-index intercepting click?
5. State actually updating?

**Investigation:**

1. `grep -rn "handlerName\|onClick"` from element to side effect — chain intact?
2. React DevTools — local state values?
3. Network tab — request fired?

**Common causes:**

| Symptom | Likely cause |
|---|---|
| Button click no fire | `<form>` default submit wrapping, disabled state, z-index overlay, wrong element bound |
| Form reloads page | Missing `event.preventDefault()` |
| State update no render | Mutation instead of replacement |
| Modal won't close | Focus trap broken, overlay click handler missing, state not flipping |
| Stale data after mutation | `onSnapshot` dep wrong, manual state not refreshed post-mutation |

### C — Cloud Function / Firestore

**Status matrix:**

| Status | Meaning | Look at |
|---|---|---|
| 401 `unauthenticated` | No valid auth token | User signed in? Token refreshed? |
| 403 `permission-denied` | Auth OK, rules/CF gate rejected | `firestore.rules`, CF `request.auth` check, custom claims |
| 403 App Check failed | Missing/invalid App Check token | `VITE_RECAPTCHA_SITE_KEY` set? Debug token for dev? |
| 429 `resource-exhausted` | Rate limit hit | User too fast, check bucket |
| 400 `invalid-argument` | Bad client data | Read `err.message` — user-safe Spanish |
| 404 `not-found` | Target doc missing | Collection/doc path, ID mapping |
| 409 `already-exists` | Idempotency collision | User retried; often not an error to surface |
| Timeout | CF slow or network slow | Railway service `/health` check |

**Investigation:**

1. Repro with DevTools Network tab open — capture URL, headers, response
2. Check CF logs: `firebase functions:log --only <functionName>`
3. Permission-denied? Read `firestore.rules`, trace the rule matching this path
4. Request headers — `X-Firebase-AppCheck` present? If missing in dev, site key isn't set
5. If CF calls Railway service: `curl <service>.up.railway.app/health`

**Quick wins:**

- Callable 401 in dev → missing App Check debug token. Ask Isaac
- `failed-precondition` → server says state doesn't allow this op. Log current state vs required
- Subscription not updating → missing unsub return from `useEffect` (leak + stale data)

### D — Performance

**Investigation:**

1. `npx lighthouse http://localhost:3000/<route>` — TTI, LCP, TBT
2. React DevTools Profiler — record slow interaction, see re-renders
3. Chrome DevTools Performance tab — long tasks (> 50ms)
4. Network throttle to "Slow 3G" — hangs or degrades gracefully?

**Common causes:**

| Symptom | Likely cause |
|---|---|
| Slow initial load | Route not lazy-loaded, oversize images, unused deps in bundle |
| Janky scroll | Heavy computation in scroll handler, > 5k DOM nodes, layout thrashing |
| Input lag | Synchronous work per keystroke (debounce), re-rendering huge list |
| Memory leak | Subscription not cleaned up, interval/timeout not cleared, detached DOM nodes |

## Output

```markdown
# Debug: <short title>

## Symptom
<one sentence>

## Root cause
<what's actually wrong, file:line>

## Why it happens
<2-4 sentences — causal chain>

## Fix
```diff
- <old>
+ <new>
```

## Why this works
<1-2 sentences>

## Verification
<exact steps to confirm — "open http://localhost:3000/loan at 360px, click Continuar, modal should open">

## Related risk (optional)
<if root cause might bite elsewhere, name where>
```

## Principles

- **One root cause per bug, ideally.** If A causes B causes C — find A, fix A, don't patch C
- **No band-aids.** `overflow: hidden` hides, doesn't fix
- **Don't rewrite healthy code.** Minimal diff
- **Suspect the recent first.** `git log -p <file>` often points at the cause
- **Reproduce before fixing.** Can't know the fix worked otherwise
