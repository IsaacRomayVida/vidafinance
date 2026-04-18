// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockEmployeeDocGet = jest.fn();
const mockEmployerDocGet = jest.fn();
const mockInviteDocSet = jest.fn().mockResolvedValue(undefined);
const mockInviteDocUpdate = jest.fn().mockResolvedValue(undefined);

const mockInviteRef = {
  set: mockInviteDocSet,
  update: mockInviteDocUpdate,
};

const mockEmployeeRef = { get: mockEmployeeDocGet };
const mockEmployerEmployeesCollection = {
  doc: jest.fn().mockReturnValue(mockEmployeeRef),
};
const mockEmployerRef = {
  get: mockEmployerDocGet,
  collection: jest.fn().mockReturnValue(mockEmployerEmployeesCollection),
};

const mockCollection = jest.fn().mockImplementation((name: string) => {
  if (name === 'employers') {
    return { doc: jest.fn().mockReturnValue(mockEmployerRef) };
  }
  if (name === 'invites') {
    return { doc: jest.fn().mockReturnValue(mockInviteRef) };
  }
  return { doc: jest.fn() };
});

const mockDb = { collection: mockCollection };

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  Timestamp: {
    now: jest.fn(() => ({
      toDate: () => new Date('2026-04-18T12:00:00.000Z'),
      toMillis: () => 1776470400000,
    })),
    fromDate: jest.fn((d: Date) => ({
      toMillis: () => d.getTime(),
      toDate: () => d,
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

let _nanoidCallCount = 0;
jest.mock('nanoid', () => ({
  nanoid: jest.fn((size?: number) => {
    _nanoidCallCount++;
    if (size === 32) return 'a'.repeat(32);
    if (size === 16) return 'invite-id-123456';
    return 'nanoid-' + _nanoidCallCount;
  }),
}));

const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { sendEmployeeInvite } from '../sendEmployeeInvite';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
const fn = sendEmployeeInvite as unknown as Handler;

const employerAuth = {
  uid: 'employer-abc',
  token: { role: 'employer_admin', email: 'admin@acme.mx' },
};

const validInput = {
  employerId: 'employer-abc',
  employeeDocId: 'emp-doc-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  _nanoidCallCount = 0;
  mockEmployeeDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      email: 'juan@acme.mx',
      name: 'Juan Perez',
      status: 'pending',
    }),
  });
  mockEmployerDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ companyName: 'ACME Logistics' }),
  });
});

describe('sendEmployeeInvite', () => {
  it('creates invite, enqueues notification, and returns success on happy path', async () => {
    const result = (await fn({ auth: employerAuth, data: validInput })) as Record<
      string,
      unknown
    >;

    expect(result.success).toBe(true);
    expect(result.inviteId).toBe('invite-id-123456');
    expect(typeof result.sentAt).toBe('string');

    // Invite doc was created with a hashed token (never the raw token itself)
    expect(mockInviteDocSet).toHaveBeenCalledTimes(1);
    const inviteDoc = mockInviteDocSet.mock.calls[0][0] as Record<string, unknown>;
    expect(inviteDoc['employerId']).toBe('employer-abc');
    expect(inviteDoc['employeeDocId']).toBe('emp-doc-1');
    expect(inviteDoc['status']).toBe('pending');
    expect(typeof inviteDoc['tokenHash']).toBe('string');
    expect((inviteDoc['tokenHash'] as string).length).toBe(64); // sha256 hex
    // Raw token must not be stored
    const raw = 'a'.repeat(32);
    expect(inviteDoc['tokenHash']).not.toBe(raw);
    expect(JSON.stringify(inviteDoc)).not.toContain(raw);

    // Notification job was enqueued with the raw token + URL
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'employee_invite',
      expect.objectContaining({
        type: 'employee_invite',
        email: 'juan@acme.mx',
        name: 'Juan Perez',
        employerName: 'ACME Logistics',
        inviteToken: raw,
        inviteUrl: `https://app.vidafinance.mx/signup?invite=${raw}`,
      })
    );

    // sentAt is written as a serverTimestamp update
    expect(mockInviteDocUpdate).toHaveBeenCalledWith({ sentAt: '__serverTimestamp__' });
  });

  it('throws permission-denied when caller is not the target employer admin', async () => {
    const otherAuth = {
      uid: 'some-other-employer',
      token: { role: 'employer_admin', email: 'other@example.com' },
    };
    await expect(fn({ auth: otherAuth, data: validInput })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mockInviteDocSet).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('throws permission-denied when caller role is not employer_admin', async () => {
    const empAuth = {
      uid: 'employer-abc',
      token: { role: 'employee', email: 'e@acme.mx' },
    };
    await expect(fn({ auth: empAuth, data: validInput })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('throws not-found when the employee doc is missing', async () => {
    mockEmployeeDocGet.mockResolvedValue({ exists: false, data: () => null });
    await expect(fn({ auth: employerAuth, data: validInput })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('throws already-exists when employee has authUid set', async () => {
    mockEmployeeDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        email: 'juan@acme.mx',
        name: 'Juan Perez',
        status: 'active',
        authUid: 'uid-already-linked',
      }),
    });
    await expect(fn({ auth: employerAuth, data: validInput })).rejects.toMatchObject({
      code: 'already-exists',
    });
  });

  it('continues when the notification queue fails', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));
    const result = (await fn({ auth: employerAuth, data: validInput })) as Record<
      string,
      unknown
    >;
    expect(result.success).toBe(true);
    expect(mockInviteDocSet).toHaveBeenCalledTimes(1);
  });
});
