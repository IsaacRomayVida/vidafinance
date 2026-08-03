import { db } from '../lib/firebase';

export interface UserProfile {
  phone: string;
  email: string;
  name?: string;
}

// Distinct from "user not found" -- the doc exists but is missing contact
// field(s) a notification needs. Callers must be able to tell "user has no
// phone/email on file" from "user has one but delivery to it failed".
export class IncompleteUserProfileError extends Error {
  constructor(uid: string, missingFields: string[]) {
    super(`User ${uid} is missing required contact field(s): ${missingFields.join(', ')}`);
    this.name = 'IncompleteUserProfileError';
  }
}

export class FirestoreService {
  /**
   * Fetch user contact data. Tries `employees/{uid}` first (primary store),
   * then falls back to `users/{uid}`.
   */
  async getUser(uid: string): Promise<UserProfile> {
    const empSnap = await db.collection('employees').doc(uid).get();
    if (empSnap.exists) {
      return this.toUserProfile(uid, empSnap.data()!);
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      return this.toUserProfile(uid, userSnap.data()!);
    }

    throw new Error(`User ${uid} not found in employees or users collections`);
  }

  private toUserProfile(uid: string, d: Record<string, unknown>): UserProfile {
    const phone = d['phone'] as string | undefined;
    const email = d['email'] as string | undefined;
    const missingFields = [!phone && 'phone', !email && 'email'].filter(Boolean) as string[];
    if (missingFields.length) {
      throw new IncompleteUserProfileError(uid, missingFields);
    }
    return { phone: phone!, email: email!, name: d['name'] as string | undefined };
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
