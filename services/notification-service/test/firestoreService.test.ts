import { setBaseEnv } from './testEnv';
setBaseEnv();

import { FirestoreService } from '../src/services/firestoreService';
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

  // DEFECT: a real employee/user doc missing the phone/email fields resolves
  // successfully with empty strings instead of surfacing the incomplete
  // record -- callers (e.g. resolvePhone) then proceed with an empty phone.
  test('DEFECT: a doc with no phone/email field resolves to empty strings, not an error', async () => {
    admin.__seed('employees', 'emp_2', { name: 'No Contact Info' });

    const svc = new FirestoreService();
    const user = await svc.getUser('emp_2');
    expect(user.phone).toBe('');
    expect(user.email).toBe('');
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
