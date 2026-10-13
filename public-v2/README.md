# public-v2 — FunPay web app

React + TypeScript + Vite. Marketing pages plus the three portals (employee,
employer, ops).

## Local development

```bash
npm ci --legacy-peer-deps
npm run dev            # http://localhost:3000
```

**`npm run dev` talks to the production Firebase project** — the config in
`src/lib/firebase.ts` is production's. Use it for marketing pages; do not sign
in to a portal with it unless you mean to act on production.

### Against the Firebase emulators

```bash
npm run dev:emulators  # = VITE_USE_FIREBASE_EMULATORS=true vite
```

With the emulators running on a `demo-*` project (start them, and seed an ops
login with data, as described in
[`docs/runbooks/payroll-remittances.md`](../docs/runbooks/payroll-remittances.md)
under "Running the ops screen locally"), Auth, Firestore, Functions and Storage
all go to `127.0.0.1` and nothing reaches production. The browser console
prints `[firebase] EMULATOR MODE …` when it is active.

| Variable | Meaning |
|---|---|
| `VITE_USE_FIREBASE_EMULATORS` | `true` on a dev server switches to the emulators. Ignored in a production build. |
| `VITE_FIREBASE_EMULATOR_PROJECT` | Emulator project id, default `demo-funpay-local`. Must start with `demo-`. |

The wiring lives in `src/lib/firebaseEmulators.ts` and is reachable only behind
`import.meta.env.DEV`. `npm run build` ends with
`scripts/check-bundle-no-emulators.mjs`, which fails the build if any of it is
in `dist/`.

## Checks

```bash
npx tsc --noEmit -p .
npm test
npm run lint
npm run build
```

---

The rest of this file is the Vite template's original README.

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
