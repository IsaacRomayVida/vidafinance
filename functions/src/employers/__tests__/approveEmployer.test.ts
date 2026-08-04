import { guardReadAfterWrite as mockGuardReadAfterWrite } from '../../__mocks__/txReadAfterWrite';
/**
 * Unit tests for approveEmployer Cloud Function
 * Target coverage: ≥90%
 */

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

const mockTransactionUpdate = jest.fn();
const mockTransactionSet = jest.fn();
const mockRunTransaction = jest.fn().mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
  await fn(mockGuardReadAfterWrite({ update: mockTransactionUpdate, set: mockTransactionSet }));
});

const mockEmployerDocGet = jest.fn();
const mockEmployerDocUpdate = jest.fn().mockResolvedValue(undefined);
const mockEmployerRef = {
  get: mockEmployerDocGet,
  update: mockEmployerDocUpdate,
  id: 'emp-123',
};

const mockUserDocGet = jest.fn();
const mockUserRef = { get: mockUserDocGet };

const mockAuditLogRef = { id: 'log-abc-123' };
const mockAuditLogCollection = {
  doc: jest.fn().mockReturnValue(mockAuditLogRef),
};

const mockWhereGet = jest.fn();
const mockWhereLimit = jest.fn().mockReturnValue({ get: mockWhereGet });
const mockWhere = jest.fn().mockReturnValue({ limit: mockWhereLimit });

const mockCollection = jest.fn().mockImplementation((name: string) => {
  if (name === 'employers') {
    return {
      doc: jest.fn().mockReturnValue(mockEmployerRef),
      where: mockWhere,
    };
  }
  if (name === 'users') {
    return { doc: jest.fn().mockReturnValue(mockUserRef) };
  }
  if (name === 'audit_log') {
    return mockAuditLogCollection;
  }
  return { doc: jest.fn().mockReturnValue({ get: jest.fn(), update: jest.fn() }) };
});

const mockDb = {
  collection: mockCollection,
  runTransaction: mockRunTransaction,
};

const mockTimestampNow = {
  toMillis: jest.fn().mockReturnValue(1700000000000),
  seconds: 1700000000,
  nanoseconds: 0,
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  Timestamp: {
    now: jest.fn(() => mockTimestampNow),
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
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
      this.name = 'HttpsError';
    }
  }
  return {
    onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
    HttpsError: MockHttpsError,
  };
});

const mockNanoid = jest.fn().mockReturnValue('AB1');
jest.mock('nanoid', () => ({
  nanoid: (...args: unknown[]) => mockNanoid(...args),
}));

const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
const mockQueue = { add: mockQueueAdd };
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => mockQueue),
}));

const mockRedisSetex = jest.fn().mockResolvedValue('OK');
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    setex: mockRedisSetex,
  }));
});

// Mock crypto dynamic import
jest.mock('crypto', () => ({
  createHash: jest.fn().mockReturnValue({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('hashed_api_key_abc123'),
  }),
}));

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

const mockResolveEntity = jest.fn().mockResolvedValue('entity-uuid-123');
const mockAddEntityRef = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/registryClient', () => ({
  resolveEntity: (...args: unknown[]) => mockResolveEntity(...args),
  addEntityRef: (...args: unknown[]) => mockAddEntityRef(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  approveEmployerHandler,
  generateEmployerCode,
  getIndustryCode,
  INDUSTRY_CODES,
} from '../approveEmployer';
import { checkRateLimit } from '../../utils/rateLimiter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(overrides: {
  auth?: { uid: string; token: Record<string, unknown> } | null;
  data?: unknown;
}) {
  return {
    auth:
      overrides.auth === null
        ? undefined
        : overrides.auth ?? {
            uid: 'admin-uid-001',
            token: { role: 'admin', email: 'admin@example.com' },
          },
    data: overrides.data ?? {
      employerId: 'emp-123',
      decision: 'approved',
    },
  };
}

function makePendingEmployerData() {
  return {
    employerId: 'emp-123',
    companyName: 'ACME Logistics',
    rfc: 'ACM123456789',
    legalRepName: 'Juan García',
    adminContactEmail: 'admin@acme.mx',
    adminContactPhone: '+5215512345678',
    industry: 'logistics',
    employeeCount: 120,
    estimatedMonthlyPayroll: 1200000,
    payrollSystem: 'Nominapp',
    payFrequency: 'biweekly',
    address: { street: 'Calle 1', city: 'CDMX', state: 'CDMX', zipCode: '06000' },
    status: 'pending_review',
    currentOutstandingBalance: 0,
    onboardingStep: 0,
    createdAt: { seconds: 1699000000, nanoseconds: 0 },
    updatedAt: { seconds: 1699000000, nanoseconds: 0 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('approveEmployer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset transaction mock
    mockRunTransaction.mockImplementation(async (fn: (txn: unknown) => Promise<void>) => {
      await fn(mockGuardReadAfterWrite({ update: mockTransactionUpdate, set: mockTransactionSet }));
    });
    // Default: no employer code collision
    mockWhereGet.mockResolvedValue({ empty: true });
    // Default employer doc
    mockEmployerDocGet.mockResolvedValue({
      exists: true,
      data: () => makePendingEmployerData(),
    });
    // nanoid returns predictable value
    mockNanoid.mockReturnValue('AB1');
  });

  // ── Auth checks ────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('throws unauthenticated when no auth is present', async () => {
      const req = makeRequest({ auth: null });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('throws permission-denied when JWT role is not admin', async () => {
      mockUserDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: 'employee', email: 'emp@example.com' }),
      });

      const req = makeRequest({
        auth: { uid: 'emp-uid', token: { role: 'employee', email: 'emp@example.com' } },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('throws permission-denied when Firestore role is not admin', async () => {
      mockUserDocGet.mockResolvedValue({
        exists: false,
        data: () => null,
      });

      const req = makeRequest({
        auth: { uid: 'emp-uid', token: { role: 'ops', email: 'ops@example.com' } },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('accepts super_admin JWT role', async () => {
      mockEmployerDocGet.mockResolvedValue({
        exists: true,
        data: () => makePendingEmployerData(),
      });

      const req = makeRequest({
        auth: { uid: 'super-uid', token: { role: 'super_admin', email: 'super@example.com' } },
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
    });

    it('accepts legacy admin token (admin: true without role)', async () => {
      const req = makeRequest({
        auth: { uid: 'legacy-uid', token: { admin: true, email: 'legacy@example.com' } },
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws invalid-argument when employerId is missing', async () => {
      const req = makeRequest({ data: { decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when employerId is empty string', async () => {
      const req = makeRequest({ data: { employerId: '', decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when decision is invalid', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'pending' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when rejecting without rejectionReason', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'rejected' },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
        message: expect.stringContaining('rejectionReason'),
      });
    });

    it('throws invalid-argument when creditLimit is negative', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'approved', creditLimit: -100 },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when creditLimit exceeds max', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'approved', creditLimit: 999999 },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('accepts valid rejection with reason', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'RFC does not match',
        },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
    });
  });

  // ── Employer document checks ───────────────────────────────────────────────

  describe('employer document checks', () => {
    it('throws not-found when employer does not exist', async () => {
      mockEmployerDocGet.mockResolvedValue({ exists: false, data: () => null });

      const req = makeRequest({ data: { employerId: 'ghost-123', decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'not-found',
        message: expect.stringContaining('ghost-123'),
      });
    });

    it('throws failed-precondition when employer is already approved', async () => {
      mockEmployerDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ ...makePendingEmployerData(), status: 'approved' }),
      });

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('approved'),
      });
    });

    it('throws failed-precondition when employer is rejected', async () => {
      mockEmployerDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ ...makePendingEmployerData(), status: 'rejected' }),
      });

      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'Incomplete docs',
        },
      });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('throws failed-precondition when employer is suspended', async () => {
      mockEmployerDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ ...makePendingEmployerData(), status: 'suspended' }),
      });

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });
  });

  // ── Successful approval ────────────────────────────────────────────────────

  describe('successful approval', () => {
    it('returns success result with employer code', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      const result = await approveEmployerHandler(req);

      expect(result.success).toBe(true);
      expect(result.employerId).toBe('emp-123');
      expect(result.status).toBe('approved');
      expect(result.employerCode).toMatch(/^MX[A-Z]{3}[A-Z0-9]{3}$/);
      expect(result.message).toContain('Employer approved');
      expect(result.message).toContain('admin@acme.mx');
    });

    it('writes update and audit log in a transaction', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockRunTransaction).toHaveBeenCalledTimes(1);
      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        mockEmployerRef,
        expect.objectContaining({ status: 'approved', approvedBy: 'admin-uid-001' })
      );
      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({
          action: 'employer.approved',
          targetCollection: 'employer',
          targetId: 'emp-123',
          actorUid: 'admin-uid-001',
          actorEmail: 'admin@example.com',
        })
      );
    });

    it('sets default creditLimit of 500000 when none provided', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        mockEmployerRef,
        expect.objectContaining({ creditLimit: 500000 })
      );
    });

    it('uses provided creditLimit when specified', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'approved', creditLimit: 250000 },
      });
      await approveEmployerHandler(req);

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        mockEmployerRef,
        expect.objectContaining({ creditLimit: 250000 })
      );
    });

    it('sets onboardingStep to 1 on approval', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        mockEmployerRef,
        expect.objectContaining({ onboardingStep: 1, currentOutstandingBalance: 0 })
      );
    });

    it('enqueues employer_approved notification', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'employer_approved',
        expect.objectContaining({
          type: 'employer_approved',
          employerId: 'emp-123',
          adminContactEmail: 'admin@acme.mx',
          companyName: 'ACME Logistics',
        })
      );
    });

    it('generates and stores API key for approved employer', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockEmployerDocUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyHash: expect.any(String) })
      );
      expect(mockRedisSetex).toHaveBeenCalledWith(
        'employer:apikey:emp-123',
        3600,
        expect.stringContaining('vida_emp_')
      );
    });

    it('handles notification queue failure gracefully', async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      const result = await approveEmployerHandler(req);

      expect(result.success).toBe(true); // notification failure must not block approval
    });

    it('handles API key generation failure gracefully', async () => {
      mockRedisSetex.mockRejectedValueOnce(new Error('Redis write failed'));

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      const result = await approveEmployerHandler(req);

      expect(result.success).toBe(true);
    });

    it('shadow-writes an employer entity to the registry with its RFC ref', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockResolveEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'firebase',
          externalId: 'emp-123',
          kind: 'employer',
          refs: [{ system: 'rfc', externalId: 'ACM123456789' }],
        })
      );
    });

    it('handles registry shadow-write failure gracefully', async () => {
      mockResolveEntity.mockRejectedValueOnce(new Error('registry unreachable'));

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      const result = await approveEmployerHandler(req);

      expect(result.success).toBe(true); // registry shadow-write failure must not block approval
      expect(mockAddEntityRef).not.toHaveBeenCalled();
    });

    it('includes notes in audit log meta', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'approved', notes: 'Verified via phone' },
      });
      await approveEmployerHandler(req);

      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({
          meta: expect.objectContaining({ notes: 'Verified via phone' }),
        })
      );
    });
  });

  // ── Successful rejection ───────────────────────────────────────────────────

  describe('successful rejection', () => {
    it('returns success result without employer code', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'RFC mismatch with SAT records',
        },
      });
      const result = await approveEmployerHandler(req);

      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
      expect(result.employerCode).toBeUndefined();
      expect(result.message).toContain('Employer rejected');
      expect(result.message).toContain('admin@acme.mx');
    });

    it('does not shadow-write a registry entity for a rejected employer', async () => {
      const req = makeRequest({
        data: { employerId: 'emp-123', decision: 'rejected', rejectionReason: 'RFC mismatch' },
      });
      await approveEmployerHandler(req);

      expect(mockResolveEntity).not.toHaveBeenCalled();
      expect(mockAddEntityRef).not.toHaveBeenCalled();
    });

    it('writes rejection fields in transaction update', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'RFC mismatch',
        },
      });
      await approveEmployerHandler(req);

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        mockEmployerRef,
        expect.objectContaining({
          status: 'rejected',
          rejectedBy: 'admin-uid-001',
          rejectionReason: 'RFC mismatch',
        })
      );
    });

    it('does not update approval fields on rejection', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'RFC mismatch',
        },
      });
      await approveEmployerHandler(req);

      const updateCall = mockTransactionUpdate.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).not.toHaveProperty('approvedAt');
      expect(updateCall).not.toHaveProperty('employerCode');
      expect(updateCall).not.toHaveProperty('creditLimit');
    });

    it('does not generate API key on rejection', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'RFC mismatch',
        },
      });
      await approveEmployerHandler(req);

      expect(mockRedisSetex).not.toHaveBeenCalled();
    });

    it('enqueues employer_rejected notification', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'SAT compliance issue',
        },
      });
      await approveEmployerHandler(req);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'employer_rejected',
        expect.objectContaining({
          type: 'employer_rejected',
          rejectionReason: 'SAT compliance issue',
        })
      );
    });

    it('writes employer.rejected to audit log', async () => {
      const req = makeRequest({
        data: {
          employerId: 'emp-123',
          decision: 'rejected',
          rejectionReason: 'Docs incomplete',
        },
      });
      await approveEmployerHandler(req);

      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({ action: 'employer.rejected' })
      );
    });
  });

  // ── Employer code generation ───────────────────────────────────────────────

  describe('generateEmployerCode', () => {
    it('generates code with correct format MX + industry + suffix', async () => {
      mockNanoid.mockReturnValue('A1B');
      const code = await generateEmployerCode(mockDb as unknown as FirebaseFirestore.Firestore, 'logistics');
      expect(code).toBe('MXLOGA1B');
    });

    it('retries on collision with existing code', async () => {
      mockWhereGet
        .mockResolvedValueOnce({ empty: false }) // first attempt: collision
        .mockResolvedValueOnce({ empty: true });  // second attempt: unique

      mockNanoid.mockReturnValueOnce('COL').mockReturnValueOnce('UNQ');
      const code = await generateEmployerCode(mockDb as unknown as FirebaseFirestore.Firestore, 'retail');
      expect(code).toBe('MXRETUNQ');
    });

    it('replaces non-alphanumeric chars with X in suffix', async () => {
      mockNanoid.mockReturnValue('a-z'); // contains hyphen
      const code = await generateEmployerCode(mockDb as unknown as FirebaseFirestore.Firestore, 'manufacturing');
      // toUpperCase() → 'A-Z', replace non-[A-Z0-9] with 'X' → 'AXZ'
      expect(code).toBe('MXMFGAXZ');
    });

    it('uses GEN for unknown industry', async () => {
      const code = await generateEmployerCode(mockDb as unknown as FirebaseFirestore.Firestore, 'unknown_sector');
      expect(code).toMatch(/^MXGEN/);
    });
  });

  // ── getIndustryCode ────────────────────────────────────────────────────────

  describe('getIndustryCode', () => {
    it.each(Object.entries(INDUSTRY_CODES))(
      'returns %s for industry "%s"',
      (industry, expectedCode) => {
        expect(getIndustryCode(industry)).toBe(expectedCode);
      }
    );

    it('is case-insensitive', () => {
      expect(getIndustryCode('Manufacturing')).toBe('MFG');
      expect(getIndustryCode('LOGISTICS')).toBe('LOG');
    });

    it('returns GEN for unknown industry', () => {
      expect(getIndustryCode('unknown')).toBe('GEN');
      expect(getIndustryCode('')).toBe('GEN');
    });
  });

  // ── Audit log structure ────────────────────────────────────────────────────

  describe('audit log', () => {
    it('captures before-state with status and updatedAt', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({
          before: expect.objectContaining({ status: 'pending_review' }),
          after: expect.objectContaining({ status: 'approved' }),
        })
      );
    });

    it('writes to the ops-readable audit_log collection', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockCollection).toHaveBeenCalledWith('audit_log');
      expect(mockCollection).not.toHaveBeenCalledWith('auditLogs');
    });

    it('includes timestamp in audit log', async () => {
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await approveEmployerHandler(req);

      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({ timestamp: mockTimestampNow })
      );
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('uses email from Firestore when not in JWT token', async () => {
      // Simulate missing email in JWT, present in Firestore users doc
      mockUserDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: 'admin', email: 'from-firestore@example.com' }),
      });

      const req = makeRequest({
        auth: { uid: 'admin-uid-001', token: { role: 'admin' } }, // no email in token
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
    });

    it('fetches admin email from Firestore when missing from token', async () => {
      mockUserDocGet
        .mockResolvedValueOnce({
          // first call: role check (not invoked when JWT role is present)
          exists: true,
          data: () => ({ role: 'admin', email: 'admin@firestore.com' }),
        });

      const req = makeRequest({
        auth: { uid: 'admin-uid-001', token: { role: 'admin' } }, // no email
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      await approveEmployerHandler(req);
      // The audit log should still be written (not throw on missing email)
      expect(mockTransactionSet).toHaveBeenCalled();
    });

    it('correctly handles technology industry code', async () => {
      mockEmployerDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ ...makePendingEmployerData(), industry: 'technology' }),
      });

      mockNanoid.mockReturnValue('XYZ');
      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      const result = await approveEmployerHandler(req);

      expect(result.employerCode).toBe('MXTECXYZ');
    });

    it('propagates Firestore transaction failure', async () => {
      mockRunTransaction.mockRejectedValueOnce(new Error('Firestore unavailable'));

      const req = makeRequest({ data: { employerId: 'emp-123', decision: 'approved' } });
      await expect(approveEmployerHandler(req)).rejects.toThrow('Firestore unavailable');
    });

    it('falls through to Firestore role check when JWT role is absent but Firestore role is admin', async () => {
      // No role in JWT — hasJwtAdminRole is false, so Firestore is checked
      mockUserDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: 'admin', email: 'admin@firestore.com' }),
      });

      const req = makeRequest({
        auth: { uid: 'admin-uid-001', token: { email: 'admin@firestore.com' } }, // no role claim
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
    });

    it('falls back to "unknown" when email is absent from both token and Firestore', async () => {
      // admin has JWT role (so no Firestore role check), but no email anywhere
      mockUserDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ role: 'admin' }), // no email field
      });

      const req = makeRequest({
        auth: { uid: 'admin-uid-001', token: { role: 'admin' } }, // no email
        data: { employerId: 'emp-123', decision: 'approved' },
      });
      const result = await approveEmployerHandler(req);
      expect(result.success).toBe(true);
      // audit log email falls back to 'unknown'
      expect(mockTransactionSet).toHaveBeenCalledWith(
        mockAuditLogRef,
        expect.objectContaining({ actorEmail: 'unknown' })
      );
    });
  });

  // ── getRedisClient / getNotificationQueue TLS branches ────────────────────

  describe('getRedisClient', () => {
    it('configures TLS when REDIS_URL starts with rediss://', async () => {
      const originalUrl = process.env['REDIS_URL'];
      process.env['REDIS_URL'] = 'rediss://localhost:6380';

      // Re-require to get fresh module with cleared singleton
      jest.resetModules();
      const { getRedisClient: freshGetRedis } = await import('../approveEmployer');
      const client = freshGetRedis();
      expect(client).toBeDefined();

      process.env['REDIS_URL'] = originalUrl;
    });
  });

  describe('getNotificationQueue', () => {
    it('configures TLS for BullMQ when REDIS_URL starts with rediss://', async () => {
      const originalUrl = process.env['REDIS_URL'];
      process.env['REDIS_URL'] = 'rediss://localhost:6380';

      jest.resetModules();
      const { getNotificationQueue: freshGetQueue } = await import('../approveEmployer');
      const q = freshGetQueue();
      expect(q).toBeDefined();

      process.env['REDIS_URL'] = originalUrl;
    });
  });

  describe('rate limiting', () => {
    it('throws resource-exhausted when rate limit is exceeded', async () => {
      (checkRateLimit as jest.Mock).mockResolvedValueOnce(false);
      const req = makeRequest({});
      await expect(approveEmployerHandler(req)).rejects.toMatchObject({
        code: 'resource-exhausted',
      });
    });
  });
});
