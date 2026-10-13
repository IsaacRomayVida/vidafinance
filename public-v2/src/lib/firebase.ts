import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  connectFirebaseEmulators,
  emulatorAppOptions,
  resolveEmulatorConfig,
  type EmulatorConfig,
} from './firebaseEmulators';

declare global {
  var FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean | undefined;
}

const firebaseConfig = {
  apiKey: 'AIzaSyD5FFDHe2mAtqfBBw6vz4-V2WflvTxCTEw',
  authDomain: 'vida-finance.firebaseapp.com',
  projectId: 'vida-finance',
  storageBucket: 'vida-finance.firebasestorage.app',
  messagingSenderId: '447766605132',
  appId: '1:447766605132:web:7d747366eb91b2452cb3e9',
  measurementId: 'G-MLCEK7E9JM',
};

// Local development against the Firebase emulators (opt-in, see
// firebaseEmulators.ts). Every use of it below sits behind a literal
// `import.meta.env.DEV`, which a production build replaces with `false`: the
// emulator code is then unreachable and is dropped from the bundle. Keep the
// literal at each site — hiding it behind a variable would ship the code.
let emulator: EmulatorConfig | null = null;
if (import.meta.env.DEV) {
  emulator = resolveEmulatorConfig(import.meta.env);
}

const app = initializeApp(import.meta.env.DEV && emulator ? emulatorAppOptions(emulator) : firebaseConfig);

// VID3-677 — App Check with reCAPTCHA Enterprise
// Only initialize when site key is configured. If unset, Cloud Functions
// with enforceAppCheck will reject client calls — that's expected until
// VID3-676 (Isaac registers the reCAPTCHA Enterprise site key).
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
const appCheckDebugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;

// In emulator mode App Check is set up by connectFirebaseEmulators (a local
// stand-in token): reCAPTCHA would be a call to Google from a session that
// must make none.
if (import.meta.env.DEV && emulator) {
  // nothing here on purpose
} else if (recaptchaSiteKey) {
  if (import.meta.env.DEV && appCheckDebugToken) {
    globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken;
  } else if (import.meta.env.DEV) {
    globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }

  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
    if (import.meta.env.DEV) console.info('[firebase] App Check initialized');
  } catch (err) {
    console.error('[firebase] App Check init failed:', err);
  }
} else if (import.meta.env.DEV) {
  console.warn(
    '[firebase] VITE_RECAPTCHA_SITE_KEY not set — App Check disabled. ' +
    'Callable CFs with enforceAppCheck will reject requests until VID3-676 is complete.'
  );
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

if (import.meta.env.DEV && emulator) {
  connectFirebaseEmulators(app, { auth, db, storage }, emulator);
}
