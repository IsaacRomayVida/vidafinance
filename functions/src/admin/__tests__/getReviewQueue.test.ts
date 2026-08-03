// Mock all external dependencies before any imports. review_queue listing needs
// where/orderBy/limit/startAfter chaining plus a batched getAll() for loans —
// the shared __mocks__/firebase-admin/firestore.ts store only supports simple
// doc get/update/add, so (like requestLoan.test.ts) this file builds its own
// lightweight in-memory Firestore fake rather than extending the shared one.
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

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

let reviewQueueDocs: FakeDoc[] = [];
let loanDocs: Record<string, Record<string, unknown>> = {};
// `loans/{loanId}/underwritingDetail/detail` (E5c) — kept as its own store
// since it is a subcollection, not a field on the loan doc (that split is
// what lets firestore.rules gate it `isOps()`-only without opening the loan
// doc itself to the same audience).
let underwritingDetailDocs: Record<string, Record<string, unknown>> = {};

interface QueryState {
  wheres: Array<{ field: string; op: string; value: unknown }>;
  orderField: string | null;
  orderDir: 'asc' | 'desc';
  limitN: number | null;
  startAfterId: string | null;
}

// Flipped by the fail-soft test to make the count() aggregation throw.
let countShouldFail = false;

// Set by the sort-fallback tests to make the ascending (oldest-first) query throw,
// standing in for production's missing `(status ASC, queuedAt ASC)` index. Firestore
// signals that as FAILED_PRECONDITION; anything else must stay fatal.
let ascQueryError: (Error & { code?: unknown }) | null = null;

function matchesWheres(d: FakeDoc, state: QueryState): boolean {
  return state.wheres.every(({ field, op, value }) => {
    const v = d.data[field];
    if (op === '==') return v === value;
    if (op === 'in') return Array.isArray(value) && (value as unknown[]).includes(v);
    return true;
  });
}

function createQueryable(state: QueryState): Record<string, unknown> {
  return {
    where: (field: string, op: string, value: unknown) =>
      createQueryable({ ...state, wheres: [...state.wheres, { field, op, value }] }),
    orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') =>
      createQueryable({ ...state, orderField: field, orderDir: dir }),
    limit: (n: number) => createQueryable({ ...state, limitN: n }),
    startAfter: (docSnap: { id: string }) => createQueryable({ ...state, startAfterId: docSnap.id }),
    count: () => ({
      get: async () => {
        if (countShouldFail) throw new Error('aggregation unavailable');
        const total = reviewQueueDocs.filter((d) => matchesWheres(d, state)).length;
        return { data: () => ({ count: total }) };
      },
    }),
    get: async () => {
      if (ascQueryError && state.orderField === 'queuedAt' && state.orderDir === 'asc') {
        throw ascQueryError;
      }
      let items = reviewQueueDocs.filter((d) => matchesWheres(d, state));
      if (state.orderField) {
        const field = state.orderField;
        items = [...items].sort((a, b) => {
          const av = a.data[field] as string;
          const bv = b.data[field] as string;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return state.orderDir === 'desc' ? -cmp : cmp;
        });
      }
      if (state.startAfterId) {
        const idx = items.findIndex((d) => d.id === state.startAfterId);
        items = idx >= 0 ? items.slice(idx + 1) : items;
      }
      if (state.limitN != null) items = items.slice(0, state.limitN);
      return { docs: items.map((d) => ({ id: d.id, data: () => d.data })) };
    },
  };
}

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'review_queue') {
      return {
        ...createQueryable({ wheres: [], orderField: null, orderDir: 'asc', limitN: null, startAfterId: null }),
        doc: jest.fn((id: string) => ({
          id,
          get: jest.fn(async () => {
            const found = reviewQueueDocs.find((d) => d.id === id);
            return found
              ? { exists: true, id, data: () => found.data }
              : { exists: false, id, data: () => undefined };
          }),
        })),
      };
    }
    if (name === 'loans') {
      return {
        doc: jest.fn((id: string) => ({
          id,
          collection: jest.fn((subName: string) => {
            if (subName !== 'underwritingDetail') throw new Error(`Unexpected subcollection: ${subName}`);
            return {
              doc: jest.fn((subId: string) => ({ id: subId, _kind: 'underwritingDetail' as const, loanId: id })),
            };
          }),
        })),
      };
    }
    throw new Error(`Unexpected collection: ${name}`);
  }),
  getAll: jest.fn(async (...refs: Array<{ id: string; _kind?: string; loanId?: string }>) =>
    refs.map((ref) => {
      if (ref._kind === 'underwritingDetail') {
        const data = underwritingDetailDocs[ref.loanId!];
        return data
          ? { id: ref.id, exists: true, data: () => data }
          : { id: ref.id, exists: false, data: () => undefined };
      }
      const data = loanDocs[ref.id];
      return data
        ? { id: ref.id, exists: true, data: () => data }
        : { id: ref.id, exists: false, data: () => undefined };
    })
  ),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
}));

import { getReviewQueue } from '../getReviewQueue';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
const fn = getReviewQueue as unknown as Handler;

const opsAuth = { uid: 'ops-uid', token: { role: 'ops', email: 'ops@test.com' } };
const employeeAuth = { uid: 'emp-uid', token: { role: 'employee', email: 'emp@test.com' } };

function seedReview(id: string, overrides: Record<string, unknown> = {}) {
  reviewQueueDocs.push({
    id,
    data: {
      loanId: `loan-${id}`,
      status: 'pending',
      queuedAt: '2026-08-01T00:00:00.000Z',
      applicantName: 'Fallback Name',
      ...overrides,
    },
  });
}

function seedLoan(id: string, overrides: Record<string, unknown> = {}) {
  loanDocs[id] = {
    employeeId: `employee-${id}`,
    employeeName: 'Juan Perez',
    employerId: `employer-${id}`,
    employerName: 'Acme Corp',
    amount: 5000,
    // Derived from the rate actually in force (LOAN_FEE_RATE = 0.3), not a round
    // placeholder. A fixture carrying a fee rate the product does not charge gets
    // copied into specs and mockups and read as the price.
    fee: 1500,
    feeRate: 0.3,
    total: 6500,
    ...overrides,
  };
}

// `loans/{loanId}/underwritingDetail/detail` (E5c) — the ops-only-gated
// breakdown. Separate from `seedLoan` on purpose: it lives in a different
// Firestore location precisely so it is NOT a field on the loan doc.
function seedUnderwritingDetail(loanId: string, data: Record<string, unknown>) {
  underwritingDetailDocs[loanId] = data;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue(true);
  reviewQueueDocs = [];
  loanDocs = {};
  underwritingDetailDocs = {};
  countShouldFail = false;
  ascQueryError = null;
});

describe('getReviewQueue', () => {
  describe('authentication & authorization', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(fn({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('throws permission-denied for employee role', async () => {
      await expect(fn({ auth: employeeAuth, data: {} })).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows ops role', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      expect(Array.isArray(result.reviews)).toBe(true);
    });
  });

  describe('ordering', () => {
    // A work queue, not an activity feed: the longest-waiting review is the most
    // urgent. Newest-first plus cursor pagination would bury it on the last page.
    it('returns the oldest review first', async () => {
      seedReview('newest', { queuedAt: '2026-08-01T12:00:00.000Z' });
      seedReview('oldest', { queuedAt: '2026-07-01T12:00:00.000Z' });
      seedReview('middle', { queuedAt: '2026-07-15T12:00:00.000Z' });
      ['newest', 'oldest', 'middle'].forEach((id) => seedLoan(`loan-${id}`));
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.id)).toEqual(['oldest', 'middle', 'newest']);
    });

    it('pages oldest-first, so the first page holds the longest-waiting work', async () => {
      for (let i = 0; i < 30; i++) {
        seedReview(`r${String(i).padStart(2, '0')}`, {
          queuedAt: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        });
        seedLoan(`loan-r${String(i).padStart(2, '0')}`);
      }
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows[0].id).toBe('r00');
      expect(rows[rows.length - 1].id).toBe('r24');
    });

    it('sorts flat by age, not grouped by status', async () => {
      seedReview('escalated-old', { status: 'escalated', queuedAt: '2026-07-01T00:00:00.000Z' });
      seedReview('pending-new', { status: 'pending_review', queuedAt: '2026-08-01T00:00:00.000Z' });
      ['escalated-old', 'pending-new'].forEach((id) => seedLoan(`loan-${id}`));
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.id)).toEqual(['escalated-old', 'pending-new']);
    });
  });

  describe('pagination', () => {
    it('defaults to 25 when no limit given', async () => {
      for (let i = 0; i < 30; i++) {
        seedReview(`r${i}`, { queuedAt: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z` });
        seedLoan(`loan-r${i}`);
      }
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      expect((result.reviews as unknown[]).length).toBe(25);
      expect(result.nextCursor).toBeTruthy();
    });

    it('clamps an oversized limit to 100', async () => {
      for (let i = 0; i < 150; i++) {
        seedReview(`r${i}`, { queuedAt: `2026-08-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z` });
        seedLoan(`loan-r${i}`);
      }
      const result = (await fn({ auth: opsAuth, data: { limit: 500 } })) as Record<string, unknown>;
      expect((result.reviews as unknown[]).length).toBe(100);
    });

    it('returns null nextCursor when fewer results than limit', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      const result = (await fn({ auth: opsAuth, data: { limit: 25 } })) as Record<string, unknown>;
      expect(result.nextCursor).toBeNull();
    });

    it('filters by status when provided', async () => {
      seedReview('r1', { status: 'pending' });
      seedReview('r2', { status: 'approved' });
      seedLoan('loan-r1');
      seedLoan('loan-r2');
      const result = (await fn({ auth: opsAuth, data: { status: 'approved' } })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('r2');
    });

    it('defaults to every status that still needs a human, and excludes resolved ones', async () => {
      seedReview('r1', { status: 'pending' });
      seedReview('r2', { status: 'pending_review' });
      seedReview('r3', { status: 'info_requested' });
      seedReview('r4', { status: 'escalated' });
      seedReview('r5', { status: 'approved' });
      seedReview('r6', { status: 'rejected' });
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].forEach((id) => seedLoan(`loan-${id}`));
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    });

    // #407/#408 regression: request_info used to make a review undecidable forever.
    // The precondition was fixed; the default list still hid the result, which put the
    // dead end back where it is harder to see. Ops asks for a document, the employee
    // sends it, and the review has to reappear in the list ops actually works.
    it('keeps an info_requested review in the default list so its answer can land', async () => {
      seedReview('r1', { status: 'info_requested' });
      seedLoan('loan-r1');
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.id)).toEqual(['r1']);
    });

    // The header counts and the default list are two statements about the same set.
    // If they ever disagree, one of them is lying to the operator.
    it('counts exactly the statuses the default list returns', async () => {
      seedReview('r1', { status: 'pending' });
      seedReview('r2', { status: 'pending_review' });
      seedReview('r3', { status: 'info_requested' });
      seedReview('r4', { status: 'escalated' });
      seedReview('r5', { status: 'approved' });
      ['r1', 'r2', 'r3', 'r4', 'r5'].forEach((id) => seedLoan(`loan-${id}`));
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const rows = result.reviews as Array<Record<string, unknown>>;
      const counts = result.counts as Record<string, number>;
      expect(Object.keys(counts).sort()).toEqual(
        [...new Set(rows.map((r) => r.status as string))].sort()
      );
    });
  });

  describe('underwriting breakdown summary', () => {
    it('returns counted passed/total plus failed condition names when breakdown exists', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      seedUnderwritingDetail('loan-r1', {
        decision: 'pending_review',
        allPass: false,
        conditions: [
          { name: 'min_tenure', pass: true, value: 12, required: 6 },
          { name: 'max_dti', pass: false, value: 0.55, required: 0.4 },
          { name: 'bureau_score', pass: false, value: 380, required: 500 },
        ],
      });
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toMatchObject({
        decision: 'pending_review',
        allPass: false,
        conditions: { passed: 1, total: 3 },
        failedConditions: ['max_dti', 'bureau_score'],
      });
    });

    // #458/#462 background: after #462, an "assumed" condition fails closed and
    // escalates. Ops needs to tell that apart from a genuine credit failure.
    it('reports all-read failures with an empty unreadFailures roll-up', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      seedUnderwritingDetail('loan-r1', {
        decision: 'pending_review',
        allPass: false,
        conditions: [
          { name: 'min_tenure', pass: true, value: 12, required: 6, source: 'read' },
          { name: 'max_dti', pass: false, value: 0.55, required: 0.4, source: 'read' },
        ],
      });
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toMatchObject({
        failedConditions: ['max_dti'],
        failedConditionDetails: [{ name: 'max_dti', source: 'read' }],
        unreadFailures: [],
      });
    });

    it('surfaces a bureau-outage shape: assumed failures land in unreadFailures', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      seedUnderwritingDetail('loan-r1', {
        decision: 'escalated',
        allPass: false,
        conditions: [
          { name: 'min_tenure', pass: true, value: 12, required: 6, source: 'read' },
          { name: 'bureau_score', pass: false, value: null, required: 500, source: 'assumed' },
          { name: 'imss_tenure', pass: false, value: null, required: 6, source: 'assumed' },
        ],
      });
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toMatchObject({
        failedConditions: ['bureau_score', 'imss_tenure'],
        failedConditionDetails: [
          { name: 'bureau_score', source: 'assumed' },
          { name: 'imss_tenure', source: 'assumed' },
        ],
        unreadFailures: ['bureau_score', 'imss_tenure'],
      });
    });

    // Loans written before #459 have conditions with no `source` key at all. That
    // is not the same claim as "a provider was down" — it must not appear in
    // unreadFailures, which is reserved for confirmed-assumed values.
    it('treats a legacy loan with no source field as unknown, not assumed', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      seedUnderwritingDetail('loan-r1', {
        decision: 'pending_review',
        allPass: false,
        conditions: [
          { name: 'max_dti', pass: false, value: 0.55, required: 0.4 }, // no `source` key
        ],
      });
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toMatchObject({
        failedConditions: ['max_dti'],
        failedConditionDetails: [{ name: 'max_dti', source: 'unknown' }],
        unreadFailures: [],
      });
    });

    it('returns null and does not throw when loan has no underwritingDecision', async () => {
      seedReview('r1');
      seedLoan('loan-r1'); // no underwritingDecision field — pre-#393 loan
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toBeNull();
    });

    it('does not throw when the loan doc is missing entirely', async () => {
      seedReview('r1'); // loanDocs has no entry for loan-r1
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(row.underwritingDecision).toBeNull();
      expect(row.amount).toBeNull();
    });
  });

  describe('field projection (no sensitive data leakage)', () => {
    it('never includes apiKeyHash, rfc, or bankClabe from the loan doc', async () => {
      seedReview('r1');
      seedLoan('loan-r1', {
        apiKeyHash: 'super-secret-hash',
        rfc: 'PEPJ800101ABC',
        bankClabe: '012345678901234567',
      });
      const result = await fn({ auth: opsAuth, data: {} });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('super-secret-hash');
      expect(serialized).not.toContain('PEPJ800101ABC');
      expect(serialized).not.toContain('012345678901234567');
    });

    it('returns only the documented summary fields per row', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'loanId',
          'employeeId',
          'employeeName',
          'employerId',
          'employerName',
          'amount',
          'feeAmount',
          'feeRate',
          'totalDue',
          'requestedAt',
          'slaDeadline',
          'status',
          'underwritingDecision',
          'riskLevel',
          'llmRiskLevel',
          'aml',
          'riskSignals',
        ].sort()
      );
    });
  });

  // #517 — the console rendered its risk pill, High Risk tile, Reason column and
  // LTI sort from a direct `onSnapshot` on `review_queue` because the projection
  // dropped these fields. They come off the review doc the handler already holds,
  // so they cost no extra read.
  describe('risk fields', () => {
    const fullRisk = {
      risk_level: 'high',
      slaDeadline: '2026-08-02T00:00:00.000Z',
      llm_narrative: {
        risk_level: 'critical',
        summary: 'Applicant shows several concerning patterns.',
        key_signals: ['thin file'],
        recommendation: 'decline',
        confidence: 0.51,
      },
      aml_result: { amlHit: true, criminalRecordFound: false, isPEP: true, amlLists: [{ list: 'OFAC' }] },
      signals: {
        riskseal: { score: 22 },
        bureau: { score: 380, activeDefaults: 2 },
        loan: { loanToSalaryRatio: 0.42, amount: 5000, employerName: 'Acme Corp' },
      },
    };

    it('serves the risk grade, AML flags and signal leaves the console renders', async () => {
      seedReview('r1', fullRisk);
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({
        riskLevel: 'high',
        llmRiskLevel: 'critical',
        slaDeadline: '2026-08-02T00:00:00.000Z',
        aml: { amlHit: true, criminalRecordFound: false, isPEP: true },
        riskSignals: {
          riskSealScore: 22,
          bureauScore: 380,
          bureauActiveDefaults: 2,
          loanToSalaryRatio: 0.42,
        },
      });
    });

    it('does not put the LLM narrative prose or the matched AML lists on the wire', async () => {
      seedReview('r1', fullRisk);
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      // The grade is the only part of the narrative any listed element renders.
      expect(Object.keys(row.aml as object).sort()).toEqual(
        ['amlHit', 'criminalRecordFound', 'isPEP'].sort()
      );
      expect(JSON.stringify(row)).not.toContain('concerning patterns');
      expect(JSON.stringify(row)).not.toContain('OFAC');
    });

    it('returns null — never false — for AML flags the pipeline never wrote', async () => {
      // A missing `isPEP` means "not checked". Reporting it as `false` would be
      // this backend asserting a clean PEP screen it never performed, and the
      // Reason column would silently stop escalating.
      seedReview('r1', { aml_result: { amlHit: true } });
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row.aml).toEqual({ amlHit: true, criminalRecordFound: null, isPEP: null });
    });

    it('nulls a risk grade outside the vocabulary this backend understands', async () => {
      seedReview('r1', { risk_level: 'SEVERE', llm_narrative: { risk_level: 7 } });
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row.riskLevel).toBeNull();
      expect(row.llmRiskLevel).toBeNull();
    });

    it('nulls each signal leaf independently when the sub-documents are partial', async () => {
      seedReview('r1', { signals: { loan: { loanToSalaryRatio: 0.18 } } });
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row.riskSignals).toEqual({
        riskSealScore: null,
        bureauScore: null,
        bureauActiveDefaults: null,
        loanToSalaryRatio: 0.18,
      });
    });

    it('returns null sub-objects, and does not throw, for a review predating these fields', async () => {
      seedReview('r1');
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({
        riskLevel: null,
        llmRiskLevel: null,
        aml: null,
        riskSignals: null,
        slaDeadline: null,
      });
    });

    it('survives sub-documents that are not objects at all', async () => {
      // Firestore returns whatever was written. Indexing into a string must not
      // take down the whole queue read.
      seedReview('r1', { aml_result: 'unavailable', signals: [], llm_narrative: 'n/a' });
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({ aml: null, riskSignals: null, llmRiskLevel: null });
    });
  });

  describe('money fields', () => {
    it('serves the fee, rate and total persisted on the loan', async () => {
      seedReview('r1');
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({ amount: 5000, feeAmount: 1500, feeRate: 0.3, totalDue: 6500 });
    });

    it('reports the rate contracted on each loan, not one shared live rate', async () => {
      // #389 made the fee rate admin-editable. A loan signed before a rate change
      // keeps its rate, so two rows in one page can legitimately disagree — the
      // reviewer must see what each borrower actually owes.
      seedReview('old', { queuedAt: '2026-07-01T00:00:00.000Z' });
      seedLoan('loan-old', { amount: 1000, fee: 80, feeRate: 0.08, total: 1080 });
      seedReview('new', { queuedAt: '2026-08-01T00:00:00.000Z' });
      seedLoan('loan-new', { amount: 1000, fee: 300, feeRate: 0.3, total: 1300 });

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const byId = Object.fromEntries(
        (result.reviews as Array<Record<string, unknown>>).map((r) => [r.id, r])
      );

      expect(byId['old']).toMatchObject({ feeAmount: 80, feeRate: 0.08, totalDue: 1080 });
      expect(byId['new']).toMatchObject({ feeAmount: 300, feeRate: 0.3, totalDue: 1300 });
    });

    it('returns null (never 0) when a legacy loan carries no money fields', async () => {
      seedReview('r1');
      loanDocs['loan-r1'] = { employeeId: 'e1', employerId: 'er1', amount: 5000 };

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({ amount: 5000, feeAmount: null, feeRate: null, totalDue: null });
    });

    it('returns null for every money field on an orphan review (no loan doc)', async () => {
      seedReview('r1'); // no seedLoan — the loan the review points at does not exist

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row).toMatchObject({ amount: null, feeAmount: null, feeRate: null, totalDue: null });
    });

    it('degrades a corrupt numeric field to null rather than emitting NaN', async () => {
      seedReview('r1');
      seedLoan('loan-r1', { fee: Number.NaN, total: '6500' });

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const row = (result.reviews as Array<Record<string, unknown>>)[0];

      expect(row['feeAmount']).toBeNull();
      expect(row['totalDue']).toBeNull();
    });
  });

  describe('status counts', () => {
    it('counts the whole collection per status, independent of the page', async () => {
      // 30 pending — more than the 25-row default page — plus other buckets.
      for (let i = 0; i < 30; i++) {
        seedReview(`p${i}`, { queuedAt: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z` });
        seedLoan(`loan-p${i}`);
      }
      seedReview('pr1', { status: 'pending_review' });
      seedLoan('loan-pr1');
      seedReview('ir1', { status: 'info_requested' });
      seedLoan('loan-ir1');
      seedReview('ok1', { status: 'approved' });
      seedLoan('loan-ok1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      const counts = result.counts as Record<string, number>;

      expect((result.reviews as unknown[]).length).toBe(25);
      expect(counts).toEqual({ pending: 30, pending_review: 1, info_requested: 1, escalated: 0 });
    });

    it('reports zero for a status with no documents rather than omitting it', async () => {
      seedReview('r1');
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;

      expect(result.counts).toEqual({ pending: 1, pending_review: 0, info_requested: 0, escalated: 0 });
    });

    it('is unaffected by the status filter applied to the list', async () => {
      seedReview('r1');
      seedLoan('loan-r1');
      seedReview('e1', { status: 'escalated' });
      seedLoan('loan-e1');

      const result = (await fn({ auth: opsAuth, data: { status: 'escalated' } })) as Record<string, unknown>;

      expect((result.reviews as unknown[]).length).toBe(1);
      expect((result.counts as Record<string, number>)['pending']).toBe(1);
    });

    it('returns counts: null (never 0) when the aggregation fails, and still serves the list', async () => {
      countShouldFail = true;
      seedReview('r1');
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;

      expect(result.counts).toBeNull();
      expect((result.reviews as unknown[]).length).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('sort order fallback (missing oldest-first index)', () => {
    function failedPrecondition(code: unknown) {
      const e = new Error(
        'FAILED_PRECONDITION: The query requires an index.'
      ) as Error & { code?: unknown };
      e.code = code;
      return e;
    }

    it('reports oldest_first when the index is present', async () => {
      seedReview('old', { queuedAt: '2026-01-01T00:00:00Z' });
      seedReview('new', { queuedAt: '2026-08-01T00:00:00Z' });
      seedLoan('loan-old');
      seedLoan('loan-new');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;

      expect(result.sortOrder).toBe('oldest_first');
      expect((result.reviews as Array<{ id: string }>)[0].id).toBe('old');
    });

    it('serves newest-first instead of dying when the index is missing (gRPC code 9)', async () => {
      ascQueryError = failedPrecondition(9);
      seedReview('old', { queuedAt: '2026-01-01T00:00:00Z' });
      seedReview('new', { queuedAt: '2026-08-01T00:00:00Z' });
      seedLoan('loan-old');
      seedLoan('loan-new');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;

      // The screen still renders — this is the whole point.
      expect((result.reviews as unknown[]).length).toBe(2);
      expect(result.sortOrder).toBe('newest_first');
      expect((result.reviews as Array<{ id: string }>)[0].id).toBe('new');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('also falls back on the string form of the code', async () => {
      ascQueryError = failedPrecondition('failed-precondition');
      seedReview('r1');
      seedLoan('loan-r1');

      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;

      expect(result.sortOrder).toBe('newest_first');
    });

    it('still returns counts and a cursor while degraded', async () => {
      ascQueryError = failedPrecondition(9);
      for (let i = 0; i < 3; i++) {
        seedReview(`r${i}`, { queuedAt: `2026-0${i + 1}-01T00:00:00Z` });
        seedLoan(`loan-r${i}`);
      }

      const result = (await fn({ auth: opsAuth, data: { limit: 2 } })) as Record<string, unknown>;

      expect(result.sortOrder).toBe('newest_first');
      expect(result.nextCursor).not.toBeNull();
      expect(result.counts).not.toBeNull();
    });

    it('honours the cursor in the fallback order rather than restarting the page', async () => {
      ascQueryError = failedPrecondition(9);
      seedReview('a', { queuedAt: '2026-01-01T00:00:00Z' });
      seedReview('b', { queuedAt: '2026-02-01T00:00:00Z' });
      seedReview('c', { queuedAt: '2026-03-01T00:00:00Z' });
      seedLoan('loan-a');
      seedLoan('loan-b');
      seedLoan('loan-c');

      // Descending order is c, b, a — starting after c must yield b, not c again.
      const result = (await fn({
        auth: opsAuth,
        data: { startAfter: 'c' },
      })) as Record<string, unknown>;

      expect((result.reviews as Array<{ id: string }>).map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('does not swallow a non-index query failure', async () => {
      const boom = new Error('backend unavailable') as Error & { code?: unknown };
      boom.code = 14;
      ascQueryError = boom;
      seedReview('r1');
      seedLoan('loan-r1');

      // Rethrown, so the shared error handler turns it into an `internal` HttpsError.
      // The point is that it surfaces at all rather than silently degrading the sort:
      // an unavailable backend is not a missing index, and its blast radius is
      // uncharacterised.
      await expect(fn({ auth: opsAuth, data: {} })).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('rate limiting', () => {
    it('throws resource-exhausted when rate limited', async () => {
      mockCheckRateLimit.mockResolvedValue(false);
      seedReview('r1');
      seedLoan('loan-r1');
      await expect(fn({ auth: opsAuth, data: {} })).rejects.toMatchObject({ code: 'resource-exhausted' });
    });

    it('fails soft (does not throw) when the rate limiter itself errors', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('redis down'));
      seedReview('r1');
      seedLoan('loan-r1');
      const result = (await fn({ auth: opsAuth, data: {} })) as Record<string, unknown>;
      expect(Array.isArray(result.reviews)).toBe(true);
    });
  });
});
