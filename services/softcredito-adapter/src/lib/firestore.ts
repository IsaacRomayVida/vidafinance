import admin from 'firebase-admin';

function initFirebase(): admin.app.App {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_B64 env var');
  }

  const svcAcct = JSON.parse(raw);
  return admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
}

initFirebase();

export const db = admin.firestore();
export default admin;
