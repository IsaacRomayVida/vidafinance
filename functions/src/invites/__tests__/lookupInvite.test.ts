// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const RAW_TOKEN = 'b'.repeat(32);
const HASHED_TOKEN = sha256(RAW_TOKEN);

const mockInviteDocRefUpdate = jest.fn().mockResolvedValue(undefined);
const mockInviteQueryGet = jest.fn();
const mockInviteLimit = jest.fn(() => ({ get: mockInviteQueryGet }));
const mockInviteWhere2 = jest.fn(() => ({ limit: mockInviteLimit }));
const mockInviteWhere1 = jest.fn(() => ({ where: mockInviteWhere2 }));

const mockEmployeeDocGet = jest.fn();
const mockEmployerDocGet = jest.fn();

const mockEmployerEmployeesCollection = {
  doc: jest.fn(() => ({ get: mockEmployeeDocGet })),
};
const mockEmployerRef = {
  get: mockEmployerDocGet,
  collection: jest.fn(() => mockEmployerEmployeesCollection),
};

const mockCollection = jest.fn((name: string) => {
  if (name === 'invites') {
    return { where: mockInviteWhere1 };
  }
  if (name === 'employers') {
    return { doc: jest.fn(() => mockEmployerRef) };
  }
  return { doc: jest.fn() };
});

const mockDb = { collection: mockCollection };

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
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

import { lookupInvite } from '../lookupInvite';
import { checkRateLimit } from '../../utils/rateLimiter';

type Handler = (req: { data: unknown; app?: { appId?: string } }) => Promise<unknown>;
const fn = lookupInvite as unknown as Handler;

function makePendingInviteDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-id-xyz',
    ref: { update: mockInviteDocRefUpdate },
    data: () => ({
      employerId: 'employer-abc',
      employeeDocId: 'emp-doc-1',
      tokenHash: HASHED_TOKEN,
      status: 'pending',
      expiresAt: {
        toMillis: () => Date.now() + 1000 * 60 * 60 * 24, // 1 day in the future
      },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkRateLimit as jest.Mock).mockResolvedValue(true);
  mockEmployeeDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ email: 'juan.perez@acme.mx', name: 'Juan Perez' }),
  });
  mockEmployerDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ companyName: 'ACME Logistics' }),
  });
});

describe('lookupInvite', () => {
  it('returns masked employee info for a valid pending token', async () => {
    mockInviteQueryGet.mockResolvedValue({
      empty: false,
      docs: [makePendingInviteDoc()],
    });

    const result = (await fn({
      data: { token: RAW_TOKEN },
      app: { appId: 'app-123' },
    })) as Record<string, unknown>;

    expect(result.valid).toBe(true);
    expect(result.employerName).toBe('ACME Logistics');
    expect(result.employeeName).toBe('Juan Perez');
    expect(result.inviteId).toBe('invite-id-xyz');
    // Email must be masked — no raw local-part leak
    expect(result.employeeEmail).not.toContain('juan.perez');
    expect(result.employeeEmail).toMatch(/^j\*+@acme\.mx$/);

    // clickedAt side-effect
    expect(mockInviteDocRefUpdate).toHaveBeenCalledWith({
      clickedAt: '__serverTimestamp__',
    });
  });

  it('returns valid=false for an expired token', async () => {
    mockInviteQueryGet.mockResolvedValue({
      empty: false,
      docs: [
        makePendingInviteDoc({
          expiresAt: { toMillis: () => Date.now() - 1000 }, // in the past
        }),
      ],
    });

    const result = (await fn({ data: { token: RAW_TOKEN } })) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_or_expired');
    // Must NOT leak any employee details
    expect(result.employeeName).toBeUndefined();
    expect(result.employeeEmail).toBeUndefined();
  });

  it('returns valid=false when no invite matches the token', async () => {
    mockInviteQueryGet.mockResolvedValue({ empty: true, docs: [] });

    const result = (await fn({ data: { token: RAW_TOKEN } })) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_or_expired');
  });

  it('throws invalid-argument for tokens of the wrong length', async () => {
    await expect(fn({ data: { token: 'too-short' } })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('throws resource-exhausted when rate-limited', async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue(false);
    await expect(
      fn({ data: { token: RAW_TOKEN }, app: { appId: 'app-123' } })
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});
