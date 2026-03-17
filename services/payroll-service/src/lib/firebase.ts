import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) throw new Error('Firebase service account not configured');

  const svcAcct = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(svcAcct),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? 'vida-finance.appspot.com',
  });
}

export const db = admin.firestore();
export const storage = admin.storage();
export { admin };
