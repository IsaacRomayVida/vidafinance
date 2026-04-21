---
apply: always
description: Non-negotiable invariants — things that must never break regardless of the task
---

# Never Break — Hard Invariants

These are non-negotiable. If a task seems to conflict with any — stop and tell Isaac. Don't work around them.

## Security

1. **App Check enforcement stays on.** `enforceAppCheck: true` on every callable CF. In frontend, don't weaken `firebase.ts`. Use debug tokens for dev.

2. **`firestore.rules` and `storage.rules` are production-sensitive.** 61+ rule tests guard them. Not modifiable from a frontend task.

3. **Never log or display:** Firebase auth ID tokens, App Check tokens, service account creds, Twilio/SendGrid/MetaMap/Conekta secrets. Even in dev console logs.

4. **Never commit `.env*` files** except `.env.example` with empty placeholder values. Current gitignored: `.env`, `.env.local`, `.env.production`.

5. **`dangerouslySetInnerHTML` only for i18n strings with known-safe `<em>` tags.** Never for CF-returned HTML or user-sourced content. For user content, sanitize with DOMPurify or render structured.

6. **Always use `httpsCallable`, never `fetch()`** to call Cloud Functions — handles auth, App Check, typed errors, retries.

7. **Don't suppress lint errors.** No `eslint-disable-next-line` without a one-line reason + Linear ticket reference. ESLint config lives in `eslint.config.js`.

## Stability

8. **Main branch is always deployable.** `cd public-v2 && npm run build` must pass cleanly before push.

9. **Never rename a route** without searching full-repo for internal links (`grep -rn "/employer/payroll" public-v2/`). App.tsx has many redirects — preserve them.

10. **Never rename an exported CF symbol** without checking every `httpsCallable(fns, 'name')` call. The name is a wire contract.

11. **Firestore doc shape changes are additive only.** Removing or renaming a field breaks in-flight clients.

## Dependencies

12. **No new runtime deps without justification.** Before `npm install <pkg>`:
    - Check `package.json` first (current deps: firebase, react, react-dom, react-router-dom, react-helmet-async, i18next, react-i18next, papaparse, tailwindcss, @tailwindcss/vite)
    - Package age < 1 year since last commit, >1000 weekly downloads, no critical CVEs
    - Bundle size impact acceptable (tree-shakes cleanly)
    - Could this be 10 lines of custom code instead?

13. **No new test runner, form library, or CSS system** as a side quest. If you need one, open a Linear ticket first.

14. **No pinned `latest` in `package.json`.** Use `^1.2.3` for ranges or `1.2.3` for exact pins on security-critical deps.

## Data

15. **Money math uses integers, not floats.** Store peso amounts as integer cents (`500000` = MXN $5,000.00). JavaScript `Number` silently loses precision on decimals.

16. **Dates are ISO strings or Firestore Timestamps.** Never local-format strings. Convert at the render boundary.

17. **Mexican identifiers validated before submit.** CURP (18 chars), RFC (13 chars), CLABE (18 digits), phone. Server re-validates — client is for UX.

## Accessibility

18. **Every interactive element is keyboard-navigable.** Tab to it, Space/Enter to activate, Esc to dismiss.

19. **Every form field has a visible label.** Not placeholder.

20. **Contrast ≥ 4.5:1 for body text, 3:1 for large text.** Check with browser devtools.

21. **No auto-play audio, no unannounced context changes.** Async content uses `aria-live="polite"`.

## Privacy

22. **No third-party analytics/tracking without sign-off.** No GA, Mixpanel, Sentry — the project currently has none.

23. **No PII in `console.log`.** No CURP, RFC, phone, email, full name, salary, CLABE tied to a person.

24. **LFPDPPP (Mexican data protection) applies.** Privacy notice linked from every page footer.

## Regulatory (SOFOM)

25. **CAT (Costo Anual Total) shown wherever loan pricing is shown.** Legally required.

26. **Contract generation is server-side only** (pdf-generator service). Client requests via `getContractDownloadUrl` → signed URL. Never render a contract client-side.

27. **E-signatures via MetaMap.** Never capture signatures in client UI.

## When you hit a conflict

If Isaac's task seems to conflict with any of the above:

1. **Stop.** Don't silently compromise.
2. **Name it:** "This conflicts with invariant N because X."
3. **Propose alternatives** — do the task differently, or open a ticket to discuss weakening the invariant (rarely the right call).
4. **Wait for explicit go-ahead.**
