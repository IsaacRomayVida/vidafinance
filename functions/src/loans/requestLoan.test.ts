// Mock all external dependencies before any imports
jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  HttpsError: class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
      this.name = 'HttpsError';
    }
  },
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: {
    now: jest.fn().mockReturnValue({
      toDate: () => new Date('2026-03-16T00:00:00.000Z'),
      toMillis: () => 1742083200000,
    }),
  },
}));

jest.mock('ioredis', () => {
  const MockIORedis = jest.fn().mockImplementation(() => ({
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(3541),
  }));
  return { default: MockIORedis, __esModule: true };
});

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
  })),
}));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));

import { getFirestore } from 'firebase-admin/firestore';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import {
  validateClabeChecksum,
  handleRequestLoan,
  _resetRedisForTesting,
  TERMS_VERSION,
  fetchBureauScore,
} from './requestLoan';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const VALID_CLABE = '032180000118359719'; // known-valid CLABE
const INVALID_CLABE_CHECKSUM = '032180000118359710'; // wrong last digit
const VALID_CLABE_ZEROS = '000000000000000013'; // computed: 0*17 digits + check=3

const mockEmployer = {
  employerId: 'employer-abc',
  employerCode: 'TESTCO',
  name: 'Test Company SA de CV',
  industry: 'technology',
  status: 'approved',
};

const mockBorrower = {
  kycStatus: 'verified',
  employerId: 'employer-abc',
  fullName: 'Juan García López',
  curpHash: 'abc123hash',
  curp: 'GARL850101HDFRPN09',
  rfc: 'GARL850101AB1',
  dateOfBirth: '1985-01-01',
  monthlySalary: 20000,
  payFrequency: 'biweekly',
  employmentTenureMonths: 24,
};

const validInput = {
  amount: 1000,
  employerCode: 'TESTCO',
  bankAccountClabe: VALID_CLABE,
  termsAccepted: true as const,
  loanPurpose: 'emergency' as const,
};

const authRequest = {
  auth: { uid: 'user-123', token: { role: 'employee' } },
  data: validInput,
};

/** Build a chainable Firestore query mock that returns the given result on .get() */
function makeQuery(getResult: { empty: boolean; docs: Array<{ data: () => Record<string, unknown>; id: string }> }) {
  const query: {
    where: jest.Mock;
    limit: jest.Mock;
    get: jest.Mock;
  } = {
    where: jest.fn(),
    limit: jest.fn(),
    get: jest.fn().mockResolvedValue(getResult),
  };
  query.where.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function makeDocRef(id = 'loan-doc-id') {
  return {
    id,
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
  };
}

/**
 * Build a mock Firestore db with configurable responses.
 * Calls to collection() are dispatched by name.
 */
function buildMockDb({
  activeLoans = [] as Array<Record<string, unknown>>,
  employers = [mockEmployer] as Array<Record<string, unknown>>,
  user = mockBorrower as Record<string, unknown> | null,
  loanDocId = 'loan-doc-id',
} = {}) {
  const loanDocRef = makeDocRef(loanDocId);
  const loansQuery = makeQuery({
    empty: activeLoans.length === 0,
    docs: activeLoans.map((d) => ({ data: () => d, id: 'active-loan-id' })),
  });
  const employersQuery = makeQuery({
    empty: employers.length === 0,
    docs: employers.map((d) => ({ data: () => d, id: d['employerId'] as string })),
  });
  const userDocSnap = {
    exists: user !== null,
    data: () => user,
  };

  return {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'users') {
        return { doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(userDocSnap) }) };
      }
      if (name === 'employers') {
        return employersQuery;
      }
      // 'loans' — first two calls are .where(...).where(...).limit().get() (active loan check),
      // then .doc() for the new loan document creation
      return {
        ...loansQuery,
        doc: jest.fn().mockReturnValue(loanDocRef),
      };
    }),
    loanDocRef,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _resetRedisForTesting();
  process.env['SOFTCREDITO_ADAPTER_URL'] = 'http://localhost:3004';
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ bureau_score: 720, active_defaults: 0, days_past_due: 0 }),
  });
  (getFirestore as jest.Mock).mockReturnValue(buildMockDb());
});

// ─── validateClabeChecksum ────────────────────────────────────────────────────

describe('validateClabeChecksum', () => {
  it('returns false for non-18-digit strings', () => {
    expect(validateClabeChecksum('12345')).toBe(false);
    expect(validateClabeChecksum('1234567890123456789')).toBe(false); // 19 digits
    expect(validateClabeChecksum('abcdefghijklmnopqr')).toBe(false); // letters
  });

  it('returns false for 18-digit string with incorrect check digit', () => {
    expect(validateClabeChecksum(INVALID_CLABE_CHECKSUM)).toBe(false);
    expect(validateClabeChecksum('000000000000000019')).toBe(false); // check should be 3
  });

  it('returns true for valid CLABEs', () => {
    expect(validateClabeChecksum(VALID_CLABE)).toBe(true);
    expect(validateClabeChecksum(VALID_CLABE_ZEROS)).toBe(true);
  });
});

// ─── handleRequestLoan ────────────────────────────────────────────────────────

describe('handleRequestLoan', () => {
  // ── Authentication ──────────────────────────────────────────────────────────

  it('throws unauthenticated when no auth context', async () => {
    const { collection: mockDb } = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue({ collection: mockDb });

    await expect(handleRequestLoan({ data: validInput })).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Authentication required',
    });
  });

  // ── Input Validation ────────────────────────────────────────────────────────

  it('throws invalid-argument for amount below minimum (not positive)', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, amount: -100 } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('throws invalid-argument for amount not a multiple of 100', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, amount: 150 } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('throws invalid-argument for amount exceeding max (5000)', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, amount: 5100 } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('throws invalid-argument for invalid employerCode format', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, employerCode: 'bad code!' } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('throws invalid-argument for CLABE not 18 digits', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, bankAccountClabe: '12345' } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('throws invalid-argument when termsAccepted is not literally true', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({
        ...authRequest,
        data: { ...validInput, termsAccepted: false },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'You must accept the terms and conditions',
    });
  });

  // ── Rate Limiting ───────────────────────────────────────────────────────────

  it('throws resource-exhausted when rate limit is exceeded', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    mockCheckRateLimit.mockResolvedValueOnce(false);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('continues when Redis throws a non-HttpsError (graceful degradation)', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await handleRequestLoan(authRequest);
    expect(result.status).toBe('pending');
  });

  // ── Active Loan Check ───────────────────────────────────────────────────────

  it('throws failed-precondition when borrower has an active loan', async () => {
    const db = buildMockDb({
      activeLoans: [{ loanId: 'existing-loan', status: 'pending' }],
    });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('active loan'),
    });
  });

  // ── Employer Validation ─────────────────────────────────────────────────────

  it('throws not-found when employerCode does not match any approved employer', async () => {
    const db = buildMockDb({ employers: [] });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('employer code'),
    });
  });

  // ── Borrower Eligibility ────────────────────────────────────────────────────

  it('throws not-found when user document does not exist', async () => {
    const db = buildMockDb({ user: null });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('User profile'),
    });
  });

  it('throws failed-precondition when KYC is not verified', async () => {
    const db = buildMockDb({ user: { ...mockBorrower, kycStatus: 'pending' } });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Identity verification'),
    });
  });

  it('throws permission-denied when employer code does not match borrower employer', async () => {
    const db = buildMockDb({
      user: { ...mockBorrower, employerId: 'different-employer' },
    });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(handleRequestLoan(authRequest)).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('Employer code'),
    });
  });

  // ── Salary Cap ──────────────────────────────────────────────────────────────

  it('throws invalid-argument when amount exceeds 30% of monthly salary', async () => {
    // monthlySalary = 1000 → 30% = 300 → cappedMax = 300
    const db = buildMockDb({ user: { ...mockBorrower, monthlySalary: 1000 } });
    (getFirestore as jest.Mock).mockReturnValue(db);

    await expect(
      handleRequestLoan({ ...authRequest, data: { ...validInput, amount: 400 } })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('Maximum loan amount'),
    });
  });

  it('caps salary limit at MXN $5,000 even for high earners', async () => {
    // monthlySalary = 100000 → 30% = 30000, but max is 5000
    // So amount 5000 should succeed (CLABE must be valid)
    const db = buildMockDb({ user: { ...mockBorrower, monthlySalary: 100000 } });
    (getFirestore as jest.Mock).mockReturnValue(db);

    const result = await handleRequestLoan({
      ...authRequest,
      data: { ...validInput, amount: 5000 },
    });
    expect(result.status).toBe('pending');
  });

  // ── CLABE Checksum ──────────────────────────────────────────────────────────

  it('throws invalid-argument for CLABE with invalid checksum', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    // INVALID_CLABE_CHECKSUM passes Zod format validation but fails checksum
    await expect(
      handleRequestLoan({
        ...authRequest,
        data: { ...validInput, bankAccountClabe: INVALID_CLABE_CHECKSUM },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('CLABE'),
    });
  });

  // ── Success Path ────────────────────────────────────────────────────────────

  it('creates loan document and returns pending status on success', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    const result = await handleRequestLoan(authRequest);

    expect(result).toEqual({
      loanId: 'loan-doc-id',
      status: 'pending',
      message: expect.stringContaining('submitted successfully'),
    });

    // Verify Firestore set was called with correct data
    expect(db.loanDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        loanId: 'loan-doc-id',
        userId: 'user-123',
        employerId: 'employer-abc',
        employerCode: 'TESTCO',
        principalAmount: 1000,
        feeAmount: 300,
        totalRepaymentAmount: 1300,
        disbursementAmount: 1000,
        currency: 'MXN',
        status: 'pending',
        termsVersion: TERMS_VERSION,
        loanPurpose: 'emergency',
      })
    );
  });

  it('stores correct borrowerSnapshot in loan document', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await handleRequestLoan(authRequest);

    expect(db.loanDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        borrowerSnapshot: expect.objectContaining({
          fullName: 'Juan García López',
          monthlySalary: 20000,
          payFrequency: 'biweekly',
          employerName: 'Test Company SA de CV',
          employerIndustry: 'technology',
        }),
      })
    );
  });

  it('dispatches underwrite_loan job to the underwriting queue on success', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await handleRequestLoan(authRequest);

    expect(Queue).toHaveBeenCalledWith(
      'vida-underwriting',
      expect.objectContaining({ connection: expect.any(Object) })
    );

    const MockQueue = Queue as unknown as jest.Mock;
    const queueInstance = MockQueue.mock.results[0].value;
    expect(queueInstance.add).toHaveBeenCalledWith(
      'underwrite_loan',
      expect.objectContaining({
        loanId: 'loan-doc-id',
        userId: 'user-123',
        principalAmount: 1000,
        employerId: 'employer-abc',
      })
    );
  });

  it('still returns success when underwriting queue is unavailable', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    const MockQueue = Queue as unknown as jest.Mock;
    MockQueue.mockImplementationOnce(() => ({
      add: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
    }));

    const result = await handleRequestLoan(authRequest);

    expect(result.status).toBe('pending');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Underwriting queue unavailable',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('works without optional loanPurpose field', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    const inputWithoutPurpose = {
      amount: 1000,
      employerCode: 'TESTCO',
      bankAccountClabe: VALID_CLABE,
      termsAccepted: true as const,
    };

    const result = await handleRequestLoan({ ...authRequest, data: inputWithoutPurpose });
    expect(result.status).toBe('pending');

    expect(db.loanDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({ loanPurpose: null })
    );
  });

  it('calls checkRateLimit with correct key and daily window', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    await handleRequestLoan(authRequest);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'rl:loan:user-123',
      3,
      86400
    );
  });

  // ── Credit Bureau Check ────────────────────────────────────────────────────

  it('calls SoftCrédito bureau/query and stores bureau fields on loan document', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ bureau_score: 680, active_defaults: 2, days_past_due: 45 }),
    });

    await handleRequestLoan(authRequest);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3004/bureau/query',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          curp: mockBorrower.curp,
          fullName: mockBorrower.fullName,
          dateOfBirth: mockBorrower.dateOfBirth,
          rfc: mockBorrower.rfc,
        }),
      })
    );

    expect(db.loanDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        bureauScore: 680,
        bureauDefaults: 2,
        bureauDaysPastDue: 45,
      })
    );
  });

  it('continues with null bureau fields when SoftCrédito is unavailable', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await handleRequestLoan(authRequest);

    expect(result.status).toBe('pending');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Credit bureau check unavailable — continuing without bureau data',
      expect.objectContaining({ error: 'ECONNREFUSED', userId: 'user-123' })
    );
    expect(db.loanDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        bureauScore: null,
        bureauDefaults: null,
        bureauDaysPastDue: null,
      })
    );
  });

  it('continues with null bureau fields when bureau returns non-OK status', async () => {
    const db = buildMockDb();
    (getFirestore as jest.Mock).mockReturnValue(db);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await handleRequestLoan(authRequest);

    expect(result.status).toBe('pending');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Credit bureau check unavailable — continuing without bureau data',
      expect.objectContaining({ error: 'Bureau query failed with status 503' })
    );
  });
});

// ─── fetchBureauScore unit tests ─────────────────────────────────────────────

describe('fetchBureauScore', () => {
  it('throws when SOFTCREDITO_ADAPTER_URL is not set', async () => {
    delete process.env['SOFTCREDITO_ADAPTER_URL'];

    await expect(
      fetchBureauScore({ curp: 'X', fullName: 'X', dateOfBirth: 'X', rfc: 'X' })
    ).rejects.toThrow('SOFTCREDITO_ADAPTER_URL not configured');
  });

  it('parses bureau response correctly', async () => {
    process.env['SOFTCREDITO_ADAPTER_URL'] = 'http://localhost:3004';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ bureau_score: 750, active_defaults: 1, days_past_due: 30 }),
    });

    const result = await fetchBureauScore({
      curp: 'GARL850101HDFRPN09',
      fullName: 'Juan García López',
      dateOfBirth: '1985-01-01',
      rfc: 'GARL850101AB1',
    });

    expect(result).toEqual({
      bureauScore: 750,
      bureauDefaults: 1,
      bureauDaysPastDue: 30,
    });
  });
});
