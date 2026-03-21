import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

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
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
