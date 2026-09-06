/**
 * Firebase client wiring for the FunPay mobile app.
 *
 * Same project and same PUBLIC client config as public-v2/src/lib/firebase.ts
 * (a Firebase web API key identifies the project; it is not a secret — access
 * control lives in firestore.rules, storage.rules and the callables' own
 * checks). Kept as a literal here for the same reason the web app keeps it as
 * one: the value is public and build-time env plumbing adds a failure mode.
 *
 * React Native differences from the web wiring, each deliberate:
 *  - Auth uses initializeAuth + AsyncStorage persistence, because getAuth()'s
 *    default web persistence does not exist in RN — without this the borrower
 *    is signed out on every app restart.
 *  - Firestore forces long polling: RN's fetch lacks the streaming transport
 *    Firestore prefers, and on many Android devices the default transport
 *    hangs the first snapshot forever, which reads as an infinite spinner —
 *    the exact F7 failure mode the web app fixed with onSnapshot error
 *    callbacks. Both defenses are used here.
 *  - App Check is not initialized yet, matching the web app's current state
 *    (VID3-676: no reCAPTCHA/Play Integrity key registered). When Isaac
 *    registers Play Integrity for mx.funpay.app, initialize it here BEFORE
 *    shipping a build with enforceAppCheck enabled server-side.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeApp } from 'firebase/app';
import * as firebaseAuth from 'firebase/auth';
import { initializeAuth, type Persistence } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// firebase's React Native entry (what Metro resolves at runtime) exports
// getReactNativePersistence, but the package's Node-facing type declarations
// — what tsc resolves — do not. Cast to the one narrow shape we use instead
// of suppressing the import: if the runtime export ever disappears, auth
// init throws on the first app start, loudly, not silently.
const { getReactNativePersistence } = firebaseAuth as unknown as {
  getReactNativePersistence: (storage: unknown) => Persistence;
};

const firebaseConfig = {
  apiKey: 'AIzaSyD5FFDHe2mAtqfBBw6vz4-V2WflvTxCTEw',
  authDomain: 'vida-finance.firebaseapp.com',
  projectId: 'vida-finance',
  storageBucket: 'vida-finance.firebasestorage.app',
  messagingSenderId: '447766605132',
  appId: '1:447766605132:web:7d747366eb91b2452cb3e9',
};

const app = initializeApp(firebaseConfig);

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
});

export const functions = getFunctions(app);
