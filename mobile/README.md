# FunPay — mobile (Android + iOS)

Expo (React Native) borrower app riding the exact backend the web app uses:
same Firebase project, same Auth, same Firestore rules, same hardened
callables (`getLoanConfig`, `requestLoan`, `generatePaymentLink`). **Zero new
server surface** — every security property from #560–#582 applies unchanged.

## v1 scope (deliberate)

- Sign in (existing borrowers), loan dashboard, live loan list with status,
  request a loan, pay via Conekta payment link (opens in browser).
- **Not** in v1: account creation / KYC. Identity verification (MetaMap) has
  no Expo Go path — it needs the native SDK and an EAS dev-client build.
  New borrowers onboard at funpay.mx; the login screen says so. v2 item.
- Spanish only, matching every borrower-facing server message.

## Run it

```bash
cd mobile
npm install
npm start          # scan the QR with Expo Go on an Android phone
npm run typecheck  # what CI gates
npm test           # pure-logic suite (loan status vocabulary, money, errors)
```

## Build an installable Android APK

EAS builds run in Expo's cloud and need an Expo account:

```bash
npm install -g eas-cli
eas login
eas build --platform android --profile preview   # → downloadable .apk
eas build --platform android --profile production # → Play Store .aab
```

Or via GitHub Actions: `.github/workflows/build-android.yml`
(**Run workflow** button) once the `EXPO_TOKEN` repo secret is set
(create at expo.dev → Account settings → Access tokens).

## Conventions carried over from the incident history

- Every `onSnapshot` carries an error callback (web F5/F7: a permission error
  must be a retry card, never an infinite spinner).
- No rate is ever rendered that the server didn't approve; a config response
  without a usable `feeRate` + `repayment` is a failure, not a quote (#424).
- Status vocabulary mirrors `functions/src/loans/loanStatus.ts` via
  `src/lib/loanStatus.ts`, kept honest by its test — the same arrangement
  public-v2 uses (separate TS projects, no shared package).
- Client totals are previews; the binding total is what `requestLoan` returns
  and freezes server-side (ADR-002).
