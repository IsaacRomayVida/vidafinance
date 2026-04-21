import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

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

const app = initializeApp(firebaseConfig);

// VID3-677 — App Check with reCAPTCHA Enterprise
// Only initialize when site key is configured. If unset, Cloud Functions
// with enforceAppCheck will reject client calls — that's expected until
// VID3-676 (Isaac registers the reCAPTCHA Enterprise site key).
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
const appCheckDebugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;

if (recaptchaSiteKey) {
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
