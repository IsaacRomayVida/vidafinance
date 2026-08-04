// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const RAW_TOKEN = 'c'.repeat(32);
const HASHED_TOKEN = sha256(RAW_TOKEN);

const mockInviteDocGet = jest.fn();
const mockEmployeeDocGet = jest.fn();

const mockEmployeeRef = { get: mockEmployeeDocGet };
const mockInviteRef = { get: mockInviteDocGet };

const mockEmployerEmployeesCollection = {
  doc: jest.fn(() => mockEmployeeRef),
};
const mockEmployerRef = {
  collection: jest.fn(() => mockEmployerEmployeesCollection),
};

const mockTxnUpdate = jest.fn();
// A real transactional read returns the document as it stands when the
// transaction runs, which is not necessarily what a plain .get() before the
// transaction returned. By default both agree; the race test below makes them
// disagree, which is the whole point of putting the invite in the read set.
const mockTxnGet = jest.fn(async (ref: { get: () => unknown }) => ref.get());
const mockRunTransaction = jest
  .fn()
  .mockImplementation(async (fn: (txn: unknown) => Promise<unknown>) =>
    fn({ get: mockTxnGet, update: mockTxnUpdate })
  );

const mockCollection = jest.fn((name: string) => {
  if (name === 'invites') {
    return { doc: jest.fn(() => mockInviteRef) };
  }
  if (name === 'employers') {
    return { doc: jest.fn(() => mockEmployerRef) };
  }
  return { doc: jest.fn() };
});

const mockDb = { collection: mockCollection, runTransaction: mockRunTransaction };

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  Timestamp: {
    now: jest.fn(() => ({
      toMillis: () => 1776470400000,
    })),
  },
  FieldValue: {
    serverTimestamp: jest.fn(() => '__serverTimestamp__'),
  },
}));

jest.mock('firebase-functions', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('firebase-functions/v2/https', () => {
  class MockHttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  }
  return {
    onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
    HttpsError: MockHttpsError,
  };
});

jest.mock('../../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { acceptInvite } from '../acceptInvite';
import { checkRateLimit } from '../../utils/rateLimiter';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
const fn = acceptInvite as unknown as Handler;

const callerAuth = {
  uid: 'new-user-uid',
  token: { role: 'employee', email: 'juan@acme.mx' },
};

const validInput = { inviteId: 'invite-xyz', token: RAW_TOKEN };

function makePendingInvite(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: () => ({
      employerId: 'employer-abc',
      employeeDocId: 'emp-doc-1',
      tokenHash: HASHED_TOKEN,
      status: 'pending',
      expiresAt: { toMillis: () => Date.now() + 86_400_000 },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxnGet.mockImplementation(async (ref: { get: () => unknown }) => ref.get());
  mockRunTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<unknown>) =>
    fn({ get: mockTxnGet, update: mockTxnUpdate })
  );
  mockInviteDocGet.mockResolvedValue(makePendingInvite());
  mockEmployeeDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ email: 'juan@acme.mx', name: 'Juan Perez', status: 'pending' }),
  });
});

describe('acceptInvite', () => {
  it('links auth uid to the employee doc and marks invite accepted (happy path)', async () => {
    const result = (await fn({ auth: callerAuth, data: validInput })) as Record<
      string,
      unknown
    >;

    expect(result.success).toBe(true);
    expect(result.employerId).toBe('employer-abc');
    expect(result.employeeDocId).toBe('emp-doc-1');

    // Transaction wrote both updates
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    // Employee doc update: status=active, authUid set
    expect(mockTxnUpdate).toHaveBeenCalledWith(
      mockEmployeeRef,
      expect.objectContaining({
        authUid: 'new-user-uid',
        signupCompletedAt: '__serverTimestamp__',
        status: 'active',
      })
    );
    // Invite doc update: status=accepted
    expect(mockTxnUpdate).toHaveBeenCalledWith(
      mockInviteRef,
      expect.objectContaining({
        status: 'accepted',
        acceptedAt: '__serverTimestamp__',
        acceptedByUid: 'new-user-uid',
      })
    );
  });

  it('throws permission-denied when caller email does not match invited employee', async () => {
    const mismatchedAuth = {
      uid: 'new-user-uid',
      token: { role: 'employee', email: 'someone-else@other.com' },
    };
    await expect(fn({ auth: mismatchedAuth, data: validInput })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // The email check now runs inside the transaction (it reads the employee
    // doc, which has to be in the transaction's read set), so what matters is
    // that the transaction wrote nothing and therefore committed nothing.
    expect(mockTxnUpdate).not.toHaveBeenCalled();
  });

  it('throws permission-denied when token hash does not match invite', async () => {
    await expect(
      fn({ auth: callerAuth, data: { ...validInput, token: 'd'.repeat(32) } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('throws failed-precondition when invite is already accepted', async () => {
    mockInviteDocGet.mockResolvedValue(makePendingInvite({ status: 'accepted' }));
    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('throws failed-precondition when invite has expired', async () => {
    mockInviteDocGet.mockResolvedValue(
      makePendingInvite({ expiresAt: { toMillis: () => Date.now() - 1000 } })
    );
    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('throws unauthenticated when no auth on request', async () => {
    await expect(fn({ data: validInput })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rejects a redemption that lost the race, instead of committing on a stale read', async () => {
    // Two people (or one person double-submitting the signup wizard) redeem the
    // same invite at once. Both take a snapshot showing status:'pending' — that
    // is what the plain .get() still returns here. The other request wins and
    // consumes the invite first, so by the time THIS request's transaction runs,
    // the invite is already accepted and this redemption must not commit.
    mockInviteDocGet.mockResolvedValue(makePendingInvite());
    mockTxnGet.mockImplementation(async (ref: { get: () => unknown }) => {
      if (ref === mockInviteRef) {
        return makePendingInvite({ status: 'accepted', acceptedByUid: 'winner-uid' });
      }
      return ref.get();
    });

    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockTxnUpdate).not.toHaveBeenCalled();
  });

  it('refuses to re-point an employee record already linked to another account', async () => {
    // A second invite was minted for this employee before the first was used
    // (the roster's Resend button), the employee then signed up with one of
    // them, and the other link is still pending. Redeeming the leftover link
    // must not hand the roster row — and the employer credit line behind it —
    // to a different uid.
    mockEmployeeDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        email: 'juan@acme.mx',
        name: 'Juan Perez',
        status: 'active',
        authUid: 'first-owner-uid',
      }),
    });

    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockTxnUpdate).not.toHaveBeenCalled();
  });

  it('still accepts when the record is already linked to the caller themselves', async () => {
    // Guards the check above against over-tightening: a retry by the rightful
    // owner is not a takeover.
    mockEmployeeDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        email: 'juan@acme.mx',
        name: 'Juan Perez',
        status: 'active',
        authUid: 'new-user-uid',
      }),
    });

    const result = (await fn({ auth: callerAuth, data: validInput })) as Record<string, unknown>;
    expect(result.success).toBe(true);
  });

  it('throws resource-exhausted when rate-limited', async () => {
    (checkRateLimit as jest.Mock).mockResolvedValueOnce(false);
    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});
