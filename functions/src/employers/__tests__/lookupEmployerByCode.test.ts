// Regression test for lookupEmployerByCode.
//
// #568 stopped NEW employerCode squats by making the mint path server-owned
// and reserved in the `employerCodes` ledger. It did nothing about the
// existing book: every code minted by the old client-side generator went
// straight onto the employer document with no uniqueness check at all, so a
// duplicate `employerCode` across two employer documents can already exist
// in production (accidental collision, or a squat performed before #568
// landed). Before this fix, `.where(...).limit(1)` resolved that duplicate
// by Firestore's default document-id ordering — silently and confidently
// handing the caller `found: true` for whichever employer happened to sort
// first. This file pins the replacement behaviour: an ambiguous code must
// fail closed (`failed-precondition`, logged) rather than pick a winner.

const mockWhereGet = jest.fn();
const mockWhere = jest.fn(() => ({ get: mockWhereGet }));
const mockCollection = jest.fn((name: string) => {
  if (name === 'employers') {
    return { where: mockWhere };
  }
  return { doc: jest.fn() };
});

const mockDb = { collection: mockCollection };

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));

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

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { lookupEmployerByCode } from '../lookupEmployerByCode';
import { checkRateLimit } from '../../utils/rateLimiter';

type Handler = (req: { data: unknown; app?: { appId?: string } }) => Promise<unknown>;
const fn = lookupEmployerByCode as unknown as Handler;

function makeEmployerDoc(id: string, companyName: string) {
  return { id, data: () => ({ companyName }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkRateLimit as jest.Mock).mockResolvedValue(true);
});

describe('lookupEmployerByCode', () => {
  it('returns found:true with the employer id and name for a single match', async () => {
    mockWhereGet.mockResolvedValue({
      empty: false,
      size: 1,
      docs: [makeEmployerDoc('emp-abc', 'ACME Logistics')],
    });

    const result = (await fn({
      data: { code: 'ACME01' },
      app: { appId: 'app-123' },
    })) as Record<string, unknown>;

    expect(result).toEqual({
      found: true,
      employerId: 'emp-abc',
      companyName: 'ACME Logistics',
    });
    // No .limit(1) — every match must be read to detect a collision.
    expect(mockWhere).toHaveBeenCalledWith('employerCode', '==', 'ACME01');
  });

  it('returns found:false when no employer carries the code', async () => {
    mockWhereGet.mockResolvedValue({ empty: true, size: 0, docs: [] });

    const result = (await fn({ data: { code: 'GHOST1' } })) as Record<string, unknown>;
    expect(result).toEqual({ found: false });
  });

  it('fails closed with failed-precondition when the code resolves to more than one employer, and logs it', async () => {
    mockWhereGet.mockResolvedValue({
      empty: false,
      size: 2,
      docs: [
        makeEmployerDoc('emp-real', 'Real Company SA'),
        makeEmployerDoc('emp-squat', 'Real Company SA'),
      ],
    });

    await expect(fn({ data: { code: 'DUPE01' } })).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    // Must not resolve to either candidate employer.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('multiple employers'),
      expect.objectContaining({
        employerCode: 'DUPE01',
        matchedEmployerIds: ['emp-real', 'emp-squat'],
      })
    );
  });

  it('throws invalid-argument for a malformed code', async () => {
    await expect(fn({ data: { code: 'a b!' } })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(mockWhereGet).not.toHaveBeenCalled();
  });

  it('throws resource-exhausted when rate-limited', async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue(false);
    await expect(
      fn({ data: { code: 'ACME01' }, app: { appId: 'app-123' } })
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(mockWhereGet).not.toHaveBeenCalled();
  });
});
