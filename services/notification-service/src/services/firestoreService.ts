import { db } from '../lib/firebase';

export interface UserProfile {
  phone: string;
  email: string;
  name?: string;
}

export class FirestoreService {
  /**
   * Fetch user contact data. Tries `employees/{uid}` first (primary store),
   * then falls back to `users/{uid}`.
   */
  async getUser(uid: string): Promise<UserProfile> {
    const empSnap = await db.collection('employees').doc(uid).get();
    if (empSnap.exists) {
      const d = empSnap.data()!;
      return { phone: d['phone'] ?? '', email: d['email'] ?? '', name: d['name'] };
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const d = userSnap.data()!;
      return { phone: d['phone'] ?? '', email: d['email'] ?? '', name: d['name'] };
    }

    throw new Error(`User ${uid} not found in employees or users collections`);
  }

  async getLoan(loanId: string): Promise<Record<string, unknown>> {
    const snap = await db.collection('loans').doc(loanId).get();
    if (!snap.exists) throw new Error(`Loan ${loanId} not found`);
    return snap.data() as Record<string, unknown>;
  }

  async logNotification(data: Record<string, unknown>): Promise<void> {
    await db.collection('notification_log').add({
      ...data,
      sentAt: (await import('firebase-admin')).firestore.FieldValue.serverTimestamp(),
    });
  }
}
