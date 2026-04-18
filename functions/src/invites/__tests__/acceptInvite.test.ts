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
const mockRunTransaction = jest
  .fn()
  .mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
    await fn({ update: mockTxnUpdate });
  });

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

jest.mock('../../utils/rateLimiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(true),
}));

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
  mockRunTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
    await fn({ update: mockTxnUpdate });
  });
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
    expect(mockRunTransaction).not.toHaveBeenCalled();
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

  it('throws resource-exhausted when rate-limited', async () => {
    (checkRateLimit as jest.Mock).mockResolvedValueOnce(false);
    await expect(fn({ auth: callerAuth, data: validInput })).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });
});
