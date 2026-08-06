// getReviewDetail did not read `loans/{loanId}/underwritingDetail/detail` at all
// (E5c). The queue row already showed "7/12 conditions passed"; opening the
// review showed nothing about which seven — the detail panel is the screen a
// reviewer is supposed to decide someone's loan on.
//
// The contract this file pins down, in the order it matters:
//
//   1. The detail endpoint does NOT summarize. All 12 conditions come back with
//      their value and the bound they were tested against. The queue's
//      count-only shape is deliberately lossy; if this endpoint were lossy too,
//      no screen in the product could answer "which check failed, and on what".
//   2. A missing document is not an error. Early-rejected loans never reach
//      Stage 3, and loans predating #393/#509 have no subcollection doc.
//   3. A condition with no `source` key reads as "unknown", never "assumed" —
//      the distinction between "the pipeline predates provenance tracking" and
//      "a provider was down when we checked". Same rule as the queue, and now
//      literally the same function (../admin/underwritingProvenance).
//   4. `value: null` survives as null. Conditions 11 and 12 persist null when
//      the bureau did not report días de atraso / cartera vencida, and a 0 or
//      `false` in its place would read to ops as a clean bureau record.

// This file has no top-level `import`, so without an explicit export TypeScript
// treats it as a global script and every `const` here collides with the identically
// named `const` in the sibling suites. Keep this.
export {};

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  onRequest: jest.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])),
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

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(() => jest.fn()),
  onDocumentUpdated: jest.fn(() => jest.fn()),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(() => jest.fn()),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: mockLogger }));

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new MockTimestamp(Math.floor(Date.now() / 1000));
  }
  static fromDate(date: Date) {
    return new MockTimestamp(Math.floor(date.getTime() / 1000));
  }
  toDate() {
    return new Date(this.seconds * 1000);
  }
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
};

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../utils/rateLimiter', () => {
  const mod = { checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});

jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

// The real 12-condition gate, transcribed from the shape
// services/underwriting-service/src/stages/stage3-autoapprove.js writes: every
// condition carries `{id, name, pass, value, required, source}`, ids 1..12.
// A fixture with fewer rows, or with invented names, would let a regression that
// drops conditions pass — the row count IS the assertion here.
//
// Two failures on purpose (bureau_score, ml_default_prob) so the panel has
// something to render, and conditions 11/12 carry `value: null` because the
// bureau block ran without those fields — the null path, not an omission.
const TWELVE_CONDITIONS = [
  { id: 1, name: 'employer_tier', pass: true, value: 1, required: '1-2', source: 'read' },
  { id: 2, name: 'imss_tenure', pass: true, value: 24, required: '> 6 months', source: 'read' },
  { id: 3, name: 'bureau_score', pass: false, value: 540, required: '> 600', source: 'read' },
  { id: 4, name: 'lti', pass: true, value: 18.4, required: '<= 25%', source: 'read' },
  { id: 5, name: 'no_competitor_loans', pass: true, value: 0, required: '0', source: 'read' },
  { id: 6, name: 'riskseal_score', pass: true, value: 72, required: '> 60', source: 'read' },
  { id: 7, name: 'fraud_risk', pass: true, value: 'medio', required: 'not alto', source: 'read' },
  { id: 8, name: 'ml_default_prob', pass: false, value: 0.31, required: '< 0.25', source: 'assumed' },
  { id: 9, name: 'no_active_defaults', pass: true, value: 0, required: '0', source: 'read' },
  { id: 10, name: 'age_range', pass: true, value: 34, required: '18-65', source: 'read' },
  { id: 11, name: 'dias_atraso_zero', pass: false, value: null, required: '0', source: 'assumed' },
  { id: 12, name: 'cartera_vencida_false', pass: false, value: null, required: 'false', source: 'assumed' },
];

const DETAIL_DOC = {
  decision: 'review',
  reason: 'bureau_score below cutoff; ml_default_prob unread',
  allPass: false,
  conditions: TWELVE_CONDITIONS,
  evaluatedAt: { _seconds: 1786000000, _nanoseconds: 0 },
};

// Set per-test. `undefined` means the subcollection document does not exist —
// the early-rejected / pre-#393 loan.
let underwritingDetailDoc: Record<string, unknown> | undefined;
// Set per-test. `null` loanId stands in for an orphan review.
let reviewLoanId: string | null = 'loan-1';

function buildMockDb() {
  const loan = { employeeId: 'emp-1', employerId: 'empr-1', amount: 3000, status: 'under_review' };

  interface Query {
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    get: jest.Mock;
  }
  const emptyQuery: Query = {
    where: jest.fn(() => emptyQuery),
    orderBy: jest.fn(() => emptyQuery),
    limit: jest.fn(() => emptyQuery),
    get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
  };

  const dataFor: Record<string, Record<string, unknown> | undefined> = {
    review_queue: { status: 'pending_review', loanId: reviewLoanId, applicantName: 'Juan García' },
    loans: loan,
    employees: { rfc: 'MAGJ900215HDF' },
    employers: { companyName: 'Grupo Textil del Bajío' },
  };

  // Records every subcollection path the handler addresses, so a test can prove
  // the read went to `underwritingDetail/detail` and not somewhere adjacent.
  const subcollectionReads: Array<{ loanId: string; sub: string; doc: string }> = [];

  return {
    subcollectionReads,
    collection: jest.fn((name: string) => ({
      ...emptyQuery,
      where: jest.fn(() => emptyQuery),
      doc: jest.fn((id: string) => ({
        id,
        collection: jest.fn((sub: string) => ({
          doc: jest.fn((subId: string) => ({
            id: subId,
            get: jest.fn(async () => {
              subcollectionReads.push({ loanId: id, sub, doc: subId });
              const exists = sub === 'underwritingDetail' && subId === 'detail' && underwritingDetailDoc !== undefined;
              return { exists, id: subId, data: () => (exists ? underwritingDetailDoc : undefined) };
            }),
          })),
        })),
        get: jest.fn().mockResolvedValue({
          exists: dataFor[name] !== undefined,
          id,
          data: () => dataFor[name],
        }),
      })),
    })),
  };
}

interface ConditionRow {
  id: number | null;
  name: string | null;
  pass: boolean | null;
  value: unknown;
  required: string | null;
  source: string;
}

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<{
  underwritingDetail: {
    decision: string | null;
    reason: string | null;
    allPass: boolean | null;
    conditions: ConditionRow[];
    evaluatedAt: unknown;
  } | null;
  review: Record<string, unknown>;
}>;

const opsAuth = { uid: 'ops-1', token: { role: 'ops', email: 'ops@vidafinance.mx' } };
const employeeAuth = { uid: 'emp-uid', token: { role: 'employee', email: 'emp@vidafinance.mx' } };

async function loadHandler(): Promise<Handler> {
  const { getReviewDetail } = await import('../index');
  return getReviewDetail as unknown as Handler;
}

describe('getReviewDetail — underwritingDetail (E5c)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    underwritingDetailDoc = DETAIL_DOC;
    reviewLoanId = 'loan-1';
    mockDb = buildMockDb();
  });

  describe('full passthrough — the detail view is not the queue', () => {
    it('returns all 12 conditions, not a passed/total count', async () => {
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail!.conditions).toHaveLength(12);
      // The queue's shape must NOT appear here: `{passed, total}` in place of the
      // rows is the exact regression this endpoint exists to avoid.
      expect(Array.isArray(result.underwritingDetail!.conditions)).toBe(true);
      expect(result.underwritingDetail!.conditions.map((c) => c.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    });

    it('carries every field of every condition, value and bound included', async () => {
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      // Exact key set per row — the panel renders all six, and a row that
      // silently loses `required` shows a value with nothing to judge it by.
      for (const c of result.underwritingDetail!.conditions) {
        expect(Object.keys(c).sort()).toEqual(
          ['id', 'name', 'pass', 'required', 'source', 'value'].sort()
        );
      }
      expect(result.underwritingDetail!.conditions[2]).toEqual({
        id: 3,
        name: 'bureau_score',
        pass: false,
        value: 540,
        required: '> 600',
        source: 'read',
      });
    });

    it('returns the decision envelope alongside the rows', async () => {
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail).toMatchObject({
        decision: 'review',
        reason: 'bureau_score below cutoff; ml_default_prob unread',
        allPass: false,
        evaluatedAt: { _seconds: 1786000000, _nanoseconds: 0 },
      });
    });

    it('reads the ops-gated subcollection document, not a field on the loan', async () => {
      const fn = await loadHandler();
      await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(mockDb.subcollectionReads).toContainEqual({
        loanId: 'loan-1',
        sub: 'underwritingDetail',
        doc: 'detail',
      });
    });
  });

  describe('fail-soft — a missing breakdown is not an error', () => {
    it('returns null when the loan has no underwritingDetail doc', async () => {
      underwritingDetailDoc = undefined;
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail).toBeNull();
    });

    it('still returns the rest of the screen when the breakdown is missing', async () => {
      // An early-rejected loan must open. Failing the whole call over an absent
      // Stage 3 record would make the reviewer unable to see the review at all.
      underwritingDetailDoc = undefined;
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.review).toMatchObject({ id: 'rev-1', status: 'pending_review' });
    });

    it('returns null without touching the subcollection when the review has no loanId', async () => {
      reviewLoanId = null;
      mockDb = buildMockDb();
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail).toBeNull();
      expect(mockDb.subcollectionReads).toHaveLength(0);
    });

    it('returns an empty conditions array, not null, when the doc exists without conditions', async () => {
      // Present-but-empty is a different statement from absent: the pipeline ran
      // and recorded a decision. The envelope must survive.
      underwritingDetailDoc = { decision: 'reject', reason: 'blocklist', allPass: false };
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail!.conditions).toEqual([]);
      expect(result.underwritingDetail!.decision).toBe('reject');
    });
  });

  describe('provenance — absent source is "unknown", never "assumed"', () => {
    it('maps a legacy condition with no source key to "unknown"', async () => {
      // Pre-#458 loans have no `source` on any condition. Reporting that as
      // "assumed" would tell ops a provider outage escalated this loan, when the
      // pipeline simply predates provenance tracking — a claim about data that
      // was never recorded.
      underwritingDetailDoc = {
        ...DETAIL_DOC,
        conditions: [{ id: 3, name: 'bureau_score', pass: false, value: 540, required: '> 600' }],
      };
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      const row = result.underwritingDetail!.conditions[0];
      expect(row.source).toBe('unknown');
      expect(row.source).not.toBe('assumed');
    });

    it('maps a non-string source to "unknown" rather than passing it through', async () => {
      underwritingDetailDoc = {
        ...DETAIL_DOC,
        conditions: [{ id: 3, name: 'bureau_score', pass: false, value: 540, required: '> 600', source: 42 }],
      };
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail!.conditions[0].source).toBe('unknown');
    });

    it('leaves genuine "read" and "assumed" provenance untouched', async () => {
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      const bySource = result.underwritingDetail!.conditions.map((c) => c.source);
      expect(bySource.filter((s) => s === 'assumed')).toHaveLength(3);
      expect(bySource.filter((s) => s === 'read')).toHaveLength(9);
      expect(bySource).not.toContain('unknown');
    });

    it('applies the same rule the queue applies — one function, no drift', async () => {
      // Both endpoints import `conditionSource`; this asserts the shared rule is
      // actually the one in force on this path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { conditionSource } = require('../admin/underwritingProvenance');
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      for (const [i, row] of result.underwritingDetail!.conditions.entries()) {
        expect(row.source).toBe(conditionSource(TWELVE_CONDITIONS[i].source));
      }
    });
  });

  describe('null values survive as null', () => {
    it('keeps value: null on conditions 11 and 12 instead of defaulting it', async () => {
      // The bureau ran but reported neither días de atraso nor cartera vencida.
      // A 0 / `false` here would render to a reviewer as a clean bureau record.
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      const rows = result.underwritingDetail!.conditions;
      const dias = rows.find((c) => c.name === 'dias_atraso_zero')!;
      const cartera = rows.find((c) => c.name === 'cartera_vencida_false')!;

      expect(dias.value).toBeNull();
      expect(cartera.value).toBeNull();
      expect(dias.value).not.toBe(0);
      expect(cartera.value).not.toBe(false);
    });

    it('does not coerce a missing pass into false', async () => {
      // A check that was never recorded is unknown, not failed. `false` would
      // paint a red row for a condition nobody ran.
      underwritingDetailDoc = {
        ...DETAIL_DOC,
        conditions: [{ id: 3, name: 'bureau_score', value: 540, required: '> 600', source: 'read' }],
      };
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail!.conditions[0].pass).toBeNull();
    });

    it('drops a non-object condition entry rather than emitting a broken row', async () => {
      underwritingDetailDoc = { ...DETAIL_DOC, conditions: ['bureau_score', null, TWELVE_CONDITIONS[0]] };
      const fn = await loadHandler();
      const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

      expect(result.underwritingDetail!.conditions).toHaveLength(1);
      expect(result.underwritingDetail!.conditions[0].name).toBe('employer_tier');
    });
  });

  describe('access', () => {
    it('refuses a non-ops caller — the subcollection is isOps() in firestore.rules', async () => {
      // The Admin SDK read bypasses firestore.rules entirely, so this callable's
      // own role gate is the only thing standing between an employee and the
      // applicant's bureau numbers. `isOps()` = ops | admin | super_admin, which
      // is exactly the withAuth list on the handler.
      const fn = await loadHandler();
      await expect(fn({ auth: employeeAuth, data: { reviewId: 'rev-1' } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('refuses an unauthenticated caller', async () => {
      const fn = await loadHandler();
      await expect(fn({ data: { reviewId: 'rev-1' } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });
  });
});
