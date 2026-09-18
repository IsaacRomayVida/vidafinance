/**
 * Employee registration — the one write that creates a borrower.
 *
 * The payload contract mirrors public-v2/src/pages/Onboarding.tsx
 * createEmployeeAccount() exactly, and firestore.rules is the reason the
 * shape is strict:
 *  - creditLimit / availableCredit / creditLimitSetAt / salarySource /
 *    riskTier / mlScore are BANNED keys (noSelfAssignedCredit) — the server
 *    derives them in onEmployeeDocCreated. Never add them.
 *  - metamapStatus / metamapVerifiedAt / metamapLastEventAt are BANNED
 *    (noSelfAssignedVerification) — only the MetaMap webhook writes them.
 *  - kycStatus may only be 'not_started' | 'pending_review' | 'rejected'
 *    from the client. Never 'approved'/'verified'.
 *  - metamapVerificationId / metamapIdentityId are conditionally spread:
 *    the keys must be OMITTED when empty, never written as '' — the MetaMap
 *    webhook matches on metamapVerificationId equality and fails closed on
 *    multiple matches, so a population of ''-valued docs would wedge it.
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import { doc, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';

import type { EmploymentTenure, PayFrequency } from './validation';

export interface RegistrationData {
  name: string;
  email: string;
  password: string;
  phone: string;
  dateOfBirth: string;
  curp: string;
  employerId: string;
  employerName: string;
  employerCode: string;
  monthlySalary: number;
  payFrequency: PayFrequency;
  employmentTenure: EmploymentTenure;
  bankClabe: string;
  kycStatus: 'not_started' | 'pending_review' | 'rejected';
  metamapVerificationId: string;
  metamapIdentityId: string;
}

/**
 * Pure payload builder, unit-tested against the rules contract. `stamp` is
 * injected so tests can assert shape without a Firestore instance.
 */
export function buildEmployeeDoc(
  data: RegistrationData,
  stamp: () => unknown = serverTimestamp
): Record<string, unknown> {
  return {
    name: data.name,
    email: data.email,
    phone: data.phone,
    dateOfBirth: data.dateOfBirth,
    curp: data.curp ? data.curp.toUpperCase() : '',
    gender: null,
    rfc: '',
    employerId: data.employerId,
    employerName: data.employerName,
    employerCode: data.employerCode.toUpperCase(),
    monthlySalary: data.monthlySalary,
    payFrequency: data.payFrequency,
    employmentTenure: data.employmentTenure,
    bankClabe: data.bankClabe,
    kycStatus: data.kycStatus,
    ...(data.metamapVerificationId
      ? {
          metamapVerificationId: data.metamapVerificationId,
          metamapIdentityId: data.metamapIdentityId,
          kycStartedAt: stamp(),
        }
      : {}),
    createdAt: stamp(),
  };
}

/**
 * Create the auth user and the employees/{uid} doc, in that order.
 *
 * auth/email-already-in-use falls back to sign-in and continues — that is
 * what makes a half-finished signup (auth created, doc write failed)
 * resumable instead of permanently locked out. After the doc write lands,
 * nothing here may throw: the account exists, and the caller navigates on.
 */
export async function registerEmployee(
  auth: Auth,
  db: Firestore,
  data: RegistrationData
): Promise<{ uid: string }> {
  let uid: string;
  try {
    const created = await createUserWithEmailAndPassword(auth, data.email.trim(), data.password);
    uid = created.user.uid;
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/email-already-in-use') {
      const signedIn = await signInWithEmailAndPassword(auth, data.email.trim(), data.password);
      uid = signedIn.user.uid;
    } else {
      throw err;
    }
  }

  await setDoc(doc(db, 'employees', uid), buildEmployeeDoc(data));
  return { uid };
}
