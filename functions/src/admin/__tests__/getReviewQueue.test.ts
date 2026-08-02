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

interface QueryState {
  wheres: Array<{ field: string; op: string; value: unknown }>;
  orderField: string | null;
  orderDir: 'asc' | 'desc';
  limitN: number | null;
  startAfterId: string | null;
}

// Flipped by the fail-soft test to make the count() aggregation throw.
let countShouldFail = false;

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
      return { doc: jest.fn((id: string) => ({ id })) };
    }
    throw new Error(`Unexpected collection: ${name}`);
  }),
  getAll: jest.fn(async (...refs: Array<{ id: string }>) =>
    refs.map((ref) => {
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
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue(true);
  reviewQueueDocs = [];
  loanDocs = {};
  countShouldFail = false;
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
      seedLoan('loan-r1', {
        underwritingDecision: {
          decision: 'pending_review',
          allPass: false,
          conditions: [
            { name: 'min_tenure', pass: true, value: 12, required: 6 },
            { name: 'max_dti', pass: false, value: 0.55, required: 0.4 },
            { name: 'bureau_score', pass: false, value: 380, required: 500 },
          ],
        },
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
          'requestedAt',
          'status',
          'underwritingDecision',
        ].sort()
      );
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
