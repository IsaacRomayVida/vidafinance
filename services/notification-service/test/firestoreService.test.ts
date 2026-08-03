import { setBaseEnv } from './testEnv';
setBaseEnv();

import { FirestoreService, IncompleteUserProfileError } from '../src/services/firestoreService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const admin = require('firebase-admin');

beforeEach(() => {
  admin.__reset();
});

describe('FirestoreService.getUser', () => {
  test('prefers the employees collection when present', async () => {
    admin.__seed('employees', 'emp_1', { phone: '5512345678', email: 'a@b.com', name: 'Ana' });
    admin.__seed('users', 'emp_1', { phone: '0000000000', email: 'wrong@b.com' });

    const svc = new FirestoreService();
    const user = await svc.getUser('emp_1');
    expect(user).toEqual({ phone: '5512345678', email: 'a@b.com', name: 'Ana' });
  });

  test('falls back to the users collection when no employees doc exists', async () => {
    admin.__seed('users', 'user_1', { phone: '5599998888', email: 'u@b.com' });

    const svc = new FirestoreService();
    const user = await svc.getUser('user_1');
    expect(user).toEqual({ phone: '5599998888', email: 'u@b.com', name: undefined });
  });

  test('throws a clear error when the uid exists in neither collection', async () => {
    const svc = new FirestoreService();
    await expect(svc.getUser('ghost')).rejects.toThrow(/User ghost not found/);
  });

  // FIXED: a real employee/user doc missing the phone/email fields now
  // surfaces the incomplete record via IncompleteUserProfileError instead of
  // resolving to empty strings -- callers (e.g. resolvePhone) can no longer
  // proceed silently with an empty phone.
  test('FIXED: a doc with no phone/email field throws IncompleteUserProfileError, not empty strings', async () => {
    admin.__seed('employees', 'emp_2', { name: 'No Contact Info' });

    const svc = new FirestoreService();
    await expect(svc.getUser('emp_2')).rejects.toThrow(IncompleteUserProfileError);
    await expect(svc.getUser('emp_2')).rejects.toThrow(/emp_2 is missing required contact field\(s\): phone/);
    await expect(svc.getUser('emp_2', ['phone', 'email'])).rejects.toThrow(
      /emp_2 is missing required contact field\(s\): phone, email/,
    );
  });

  // A borrower with a working phone and no email on file is still reachable by
  // SMS/WhatsApp -- the only channels this service sends on. Demanding `email`
  // by default would suppress every notification for that borrower.
  test('a doc with a phone but no email is returned, not rejected', async () => {
    admin.__seed('employees', 'emp_3', { phone: '5512345678' });

    const svc = new FirestoreService();
    const user = await svc.getUser('emp_3');
    expect(user.phone).toBe('5512345678');
    expect(user.email).toBeUndefined();
  });

  test('a caller that explicitly needs an email still gets it enforced', async () => {
    admin.__seed('employees', 'emp_3b', { phone: '5512345678' });

    const svc = new FirestoreService();
    await expect(svc.getUser('emp_3b', ['email'])).rejects.toThrow(
      /missing required contact field\(s\): email/,
    );
  });

  test('FIXED: a doc with an email but no phone reports only the missing field', async () => {
    admin.__seed('employees', 'emp_4', { email: 'a@b.com' });

    const svc = new FirestoreService();
    await expect(svc.getUser('emp_4')).rejects.toThrow(/missing required contact field\(s\): phone/);
  });

  test('an incomplete profile is distinguishable from a "user not found" error', async () => {
    admin.__seed('employees', 'emp_5', {});
    const svc = new FirestoreService();

    let incompleteErr: unknown;
    try {
      await svc.getUser('emp_5');
    } catch (err) {
      incompleteErr = err;
    }
    expect(incompleteErr).toBeInstanceOf(IncompleteUserProfileError);

    await expect(svc.getUser('ghost')).rejects.not.toBeInstanceOf(IncompleteUserProfileError);
  });
});

describe('FirestoreService.getLoan', () => {
  test('returns the loan document data', async () => {
    admin.__seed('loans', 'loan_1', { amount: 1000, status: 'active' });
    const svc = new FirestoreService();
    await expect(svc.getLoan('loan_1')).resolves.toEqual({ amount: 1000, status: 'active' });
  });

  test('throws a clear error when the loan does not exist', async () => {
    const svc = new FirestoreService();
    await expect(svc.getLoan('does_not_exist')).rejects.toThrow(/Loan does_not_exist not found/);
  });
});
