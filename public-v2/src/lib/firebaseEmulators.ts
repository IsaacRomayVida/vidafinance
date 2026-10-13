/**
 * firebaseEmulators.ts — opt-in wiring of the web app to the local Firebase
 * Emulator Suite, for development only.
 *
 * Without it a local dev server signs in to, reads and writes the PRODUCTION
 * project: `firebase.ts` carries production's config and nothing else. With
 * `VITE_USE_FIREBASE_EMULATORS=true` on a dev server, the app is initialised
 * against a `demo-*` project with a placeholder API key and every SDK is
 * pointed at 127.0.0.1 — a `demo-*` project id cannot reach a real Firebase
 * project even if one of the connect calls were missed.
 *
 * It cannot be switched on in a production build, three times over:
 *   1. `firebase.ts` calls into this file only inside `if (import.meta.env.DEV)`.
 *      Vite replaces that with `false` in a production build and the bundler
 *      drops the branch, so none of this file ships. `npm run build` ends with
 *      scripts/check-bundle-no-emulators.mjs, which fails the build if any of
 *      the markers below is found in dist/.
 *   2. `resolveEmulatorConfig` itself returns null unless `DEV` is true,
 *      whatever the flag says.
 *   3. The project id must start with `demo-` and the host must be loopback,
 *      or it throws instead of connecting.
 *
 * Run it: docs/runbooks/payroll-remittances.md, "Running the ops screen locally".
 */
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { connectAuthEmulator, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

/** Matches scripts/seed-remittance-emulator.mjs and the runbook's `--project`. */
export const EMULATOR_DEFAULT_PROJECT = 'demo-funpay-local';
export const EMULATOR_HOST = '127.0.0.1';
/** The `emulators` block of firebase.json. firebaseEmulators.test.ts keeps the two in step. */
// A plain literal, not Object.freeze(...): a call at module top level is kept by
// the bundler as a possible side effect, and the ports then shipped to production.
export const EMULATOR_PORTS = { auth: 9099, firestore: 8080, functions: 5001, storage: 9199 } as const;
/** Every callable in this app is deployed to, and called in, this region. */
const FUNCTIONS_REGION = 'us-central1';

export interface EmulatorConfig {
  projectId: string;
  host: string;
  ports: { auth: number; firestore: number; functions: number; storage: number };
}

/** The slice of `import.meta.env` this decision reads. */
export interface EmulatorEnv {
  DEV?: boolean;
  VITE_USE_FIREBASE_EMULATORS?: string;
  VITE_FIREBASE_EMULATOR_PROJECT?: string;
}

/**
 * Whether to use the emulators, and which. Null — use the real project —
 * unless this is a dev build AND the flag is exactly "true".
 * Throws for a project id that is not `demo-*`: silently falling back to
 * production because of a typo is the one outcome this must not have.
 */
export function resolveEmulatorConfig(env: EmulatorEnv): EmulatorConfig | null {
  if (env.DEV !== true) return null;
  if (env.VITE_USE_FIREBASE_EMULATORS !== 'true') return null;
  const projectId = (env.VITE_FIREBASE_EMULATOR_PROJECT ?? '').trim() || EMULATOR_DEFAULT_PROJECT;
  if (!/^demo-[a-z0-9-]+$/.test(projectId)) {
    throw new Error(
      `[firebase] VITE_USE_FIREBASE_EMULATORS is on but the project id "${projectId}" is not a demo-* id. ` +
        'Emulator mode only ever runs against a demo-* project, which cannot reach a real one.',
    );
  }
  return { projectId, host: EMULATOR_HOST, ports: { ...EMULATOR_PORTS } };
}

/**
 * The app config for emulator mode. Nothing of production's is carried over:
 * no real API key, no auth domain, no sender or measurement id.
 */
export function emulatorAppOptions(config: EmulatorConfig): FirebaseOptions {
  return {
    apiKey: 'demo-api-key-emulator-only',
    projectId: config.projectId,
    storageBucket: `${config.projectId}.appspot.com`,
    appId: 'demo-app-id-emulator-only',
  };
}

/**
 * A stand-in App Check token for the emulators. The callables are deployed with
 * `enforceAppCheck: true`; the functions emulator does not verify a token but
 * does refuse a request that carries none. This is not a credential: it is
 * unsigned, minted here in the browser with no network call, and a deployed
 * function verifies the signature and rejects it.
 */
export function emulatorAppCheckToken(appId: string): string {
  const part = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: appId, emulator: true })}.emulator-only-app-check`;
}

/** Points every SDK the app uses at the local emulators. Call once, before first use. */
export function connectFirebaseEmulators(
  app: FirebaseApp,
  services: { auth: Auth; db: Firestore; storage: FirebaseStorage },
  config: EmulatorConfig,
): void {
  const { host, ports } = config;
  // CustomProvider instead of reCAPTCHA: no call to Google from this session.
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => ({
        token: emulatorAppCheckToken(emulatorAppOptions(config).appId ?? config.projectId),
        expireTimeMillis: Date.now() + 60 * 60 * 1000,
      }),
    }),
    isTokenAutoRefreshEnabled: false,
  });
  connectAuthEmulator(services.auth, `http://${host}:${ports.auth}`, { disableWarnings: true });
  connectFirestoreEmulator(services.db, host, ports.firestore);
  connectStorageEmulator(services.storage, host, ports.storage);
  // Pages call `getFunctions()` with no arguments; that is this same instance
  // (default app, default region), so connecting it once covers all of them.
  connectFunctionsEmulator(getFunctions(app, FUNCTIONS_REGION), host, ports.functions);
  console.info(
    `[firebase] EMULATOR MODE — project ${config.projectId} on ${host} ` +
      `(auth ${ports.auth}, firestore ${ports.firestore}, functions ${ports.functions}, storage ${ports.storage}). ` +
      'Nothing in this session reaches production.',
  );
}
