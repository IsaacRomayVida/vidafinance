import { db } from '../lib/firebase';

export interface UserProfile {
  phone?: string;
  email?: string;
  name?: string;
}

export type ContactField = 'phone' | 'email';

// Every notification this service sends today is SMS/WhatsApp, so `phone` is
// the only field a caller actually needs. Demanding `email` as well would drop
// notifications for a borrower who has a working phone and no email on file.
const DEFAULT_REQUIRED_FIELDS: ContactField[] = ['phone'];

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
   *
   * Throws `IncompleteUserProfileError` when the doc exists but is missing a
   * field the caller declared it needs. Only the declared fields are checked --
   * a record missing a field nobody asked for is returned unchanged.
   */
  async getUser(uid: string, required: ContactField[] = DEFAULT_REQUIRED_FIELDS): Promise<UserProfile> {
    const empSnap = await db.collection('employees').doc(uid).get();
    if (empSnap.exists) {
      return this.toUserProfile(uid, empSnap.data()!, required);
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      return this.toUserProfile(uid, userSnap.data()!, required);
    }

    throw new Error(`User ${uid} not found in employees or users collections`);
  }

  private toUserProfile(
    uid: string,
    d: Record<string, unknown>,
    required: ContactField[],
  ): UserProfile {
    const profile: UserProfile = {
      phone: (d['phone'] as string | undefined) || undefined,
      email: (d['email'] as string | undefined) || undefined,
      name: d['name'] as string | undefined,
    };
    const missingFields = required.filter((f) => !profile[f]);
    if (missingFields.length) {
      throw new IncompleteUserProfileError(uid, missingFields);
    }
    return profile;
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
