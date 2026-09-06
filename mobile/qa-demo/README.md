# Mobile QA demo — run the app against local emulators

See the mobile app in action with **zero contact with production**: local
Firebase emulators (Auth + Firestore + Functions), stub callables that
return fixtures, and a seeded demo borrower. This is the "QA fixtures over
live rails" path — the payment link the demo returns points at a reserved
`.invalid` domain and can never charge anyone.

## Run it

```bash
# 1. Emulators (needs Java; firebase-tools via npx is fine)
cd mobile/qa-demo/functions && npm install && cd ..
npx firebase-tools emulators:start --project demo-funpay

# 2. Seed (second terminal) — prints the demo credentials
node seed.mjs

# 3. The app, pointed at the emulators (third terminal)
cd mobile
EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1 npm start   # or: npx expo start --web
```

Sign in with the credentials `seed.mjs` prints
(`maria.qa@demo.funpay.mx` / `demo-funpay-qa`).

On a phone/emulator instead of web, also set
`EXPO_PUBLIC_EMULATOR_HOST=<your machine's LAN IP>` so the device can reach
the emulators.

## Why this cannot touch production

- `EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1` swaps the app's project id to
  `demo-funpay` — a `demo-` project id is Firebase's offline namespace; the
  SDKs and emulators refuse to bridge it to any real project.
- Every SDK is explicitly pointed at 127.0.0.1 emulator ports.
- The stub `generatePaymentLink` returns `https://pago-simulado.invalid/…`
  (RFC 2606 reserved TLD — unresolvable by design).
- Store builds never set the flag; without it, this entire path is
  dead code stripped at bundle time.

## What the stubs mirror (and what they don't)

`functions/index.js` copies the **names and response shapes** of
`getLoanConfig`, `requestLoan`, and `generatePaymentLink` from
`functions/src/index.ts`, plus their auth + basic input checks — enough for
the screens to behave realistically. They deliberately have none of the
real underwriting, ADR-002 freezing, or Conekta logic; the server remains
the single source of truth. If a callable's response shape changes, update
the stub (the mobile client's own refusal rules in `src/api/callables.ts`
will fail loudly here first — which is the point).
