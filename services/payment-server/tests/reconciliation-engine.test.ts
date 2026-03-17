/**
 * Integration tests for the reconciliation engine (src/services/reconciliation.ts).
 * Tests the 3 matching strategies: reference, CLABE+amount, manual review.
 */

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.INTERNAL_API_SECRET = 'test-secret';

import { __resetPushed, __getPushed } from './__mocks__/redis';
import { db, admin, __resetMockStore, __setMockData, __getMockStore } from './__mocks__/firebase';

// ── Helpers to control Firestore query behavior ────────────────────────────

type DocEntry = {
  id: string;
  data: Record<string, unknown>;
};

function makeLoanDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    exists: true,
    data: () => ({ ...data }),
    ref: {
      update: jest.fn().mockResolvedValue(undefined),
      path: `loans/${id}`,
    },
  };
}

function makeQuerySnap(docs: ReturnType<typeof makeLoanDoc>[]) {
  return { empty: docs.length === 0, docs };
}

/**
 * Patch db.collection to return controlled query results for loans
 * and track writes to manual_review and other collections.
 */
let queryResults: Array<ReturnType<typeof makeQuerySnap>> = [];
let queryCallIndex = 0;
const addedDocs: Array<{ collection: string; data: Record<string, unknown> }> = [];
let transactionUpdates: Array<{ path: string; data: Record<string, unknown> }> = [];

function setupMockDb() {
  queryCallIndex = 0;
  addedDocs.length = 0;
  transactionUpdates.length = 0;

  const mockCollection = (name: string) => {
    const chain: Record<string, unknown> = {
      doc: jest.fn((id: string) => ({
        path: `${name}/${id}`,
        get: jest.fn(async () => {
          const store = __getMockStore();
          const data = store[`${name}/${id}`];
          return {
            exists: !!data,
            id,
            data: () => data ?? {},
            ref: { path: `${name}/${id}` },
          };
        }),
        set: jest.fn(async (data: Record<string, unknown>) => {
          __setMockData(`${name}/${id}`, data);
        }),
        update: jest.fn(async (data: Record<string, unknown>) => {
          const store = __getMockStore();
          __setMockData(`${name}/${id}`, { ...(store[`${name}/${id}`] ?? {}), ...data });
        }),
      })),
      add: jest.fn(async (data: Record<string, unknown>) => {
        addedDocs.push({ collection: name, data });
        return { id: `auto_${Date.now()}` };
      }),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(async () => {
        const result = queryResults[queryCallIndex] ?? makeQuerySnap([]);
        queryCallIndex++;
        return result;
      }),
    };
    return chain;
  };

  (db.collection as jest.Mock).mockImplementation(mockCollection);

  (db.runTransaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      get: jest.fn(async (ref: { path?: string }) => {
        const store = __getMockStore();
        const path = ref.path ?? '';
        const data = store[path] ?? {};
        return { exists: !!data, data: () => data };
      }),
      update: jest.fn((ref: { path?: string }, data: Record<string, unknown>) => {
        transactionUpdates.push({ path: ref?.path ?? 'unknown', data });
      }),
      set: jest.fn(),
    });
  });
}

// Import reconciliation AFTER mock setup (moduleNameMapper handles firebase/redis redirection)
import { reconcilePayment, IncomingPayment } from '../src/services/reconciliation';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('reconcilePayment — reconciliation engine', () => {
  beforeEach(() => {
    __resetMockStore();
    __resetPushed();
    queryResults = [];
    jest.clearAllMocks();
    setupMockDb();
  });

  // ── Strategy 1: match by STP reference number ────────────────────────

  describe('Strategy 1: match by STP reference number', () => {
    it('should match a loan by reference number and mark it repaid', async () => {
      const loanDoc = makeLoanDoc('loan-ref-001', {
        status: 'disbursed',
        employerId: 'emp001',
        userId: 'user-abc',
        stpReferenceNumber: 'REF-12345',
      });

      // First query (reference match) succeeds
      queryResults = [makeQuerySnap([loanDoc])];

      // Seed store for post-transaction userId lookup
      __setMockData('loans/loan-ref-001', {
        userId: 'user-abc',
        employerId: 'emp001',
        status: 'disbursed',
      });

      const payment: IncomingPayment = {
        id: 'pay-001',
        referenceNumber: 'REF-12345',
        amount: 5000,
        receivedAt: '2026-03-17T12:00:00Z',
      };

      const result = await reconcilePayment(payment);

      expect(result.matched).toBe(true);
      expect(result.strategy).toBe('reference_match');
      expect(result.loanId).toBe('loan-ref-001');
      expect(result.paymentId).toBe('pay-001');

      // Verify transaction updated loan to repaid
      const loanUpdate = transactionUpdates.find((u) => u.path.includes('loans'));
      expect(loanUpdate).toBeDefined();
      expect(loanUpdate!.data.status).toBe('repaid');
      expect(loanUpdate!.data.reconciliationStrategy).toBe('reference_match');

      // Verify employer balance decremented
      const employerUpdate = transactionUpdates.find((u) => u.path.includes('employers'));
      expect(employerUpdate).toBeDefined();
      expect(employerUpdate!.data.outstandingBalance).toEqual({ _increment: -5000 });

      // Verify notification pushed to Redis
      const pushed = __getPushed();
      expect(pushed.length).toBeGreaterThanOrEqual(1);
      const notification = JSON.parse(pushed[0][1]);
      expect(notification.type).toBe('loan_repaid');
      expect(notification.loanId).toBe('loan-ref-001');
      expect(notification.amount).toBe(5000);
    });

    it('should skip reference strategy when no referenceNumber provided', async () => {
      // No reference, no CLABE → manual review
      queryResults = [];

      const payment: IncomingPayment = {
        id: 'pay-no-ref',
        amount: 1000,
        receivedAt: '2026-03-17T12:00:00Z',
      };

      const result = await reconcilePayment(payment);

      expect(result.matched).toBe(false);
      expect(result.strategy).toBe('manual_review');
    });
  });

  // ── Strategy 2: match by employer CLABE + amount ─────────────────────

  describe('Strategy 2: match by employer CLABE + amount', () => {
    it('should match a loan by sender CLABE and amount', async () => {
      const loanDoc = makeLoanDoc('loan-clabe-001', {
        status: 'overdue',
        employerId: 'emp002',
        userId: 'user-xyz',
        employerClabe: '012345678901234567',
        repaymentAmount: 3500,
      });

      // First query (reference) misses, second query (CLABE+amount) hits
      queryResults = [makeQuerySnap([]), makeQuerySnap([loanDoc])];

      __setMockData('loans/loan-clabe-001', {
        userId: 'user-xyz',
        employerId: 'emp002',
        status: 'overdue',
      });

      const payment: IncomingPayment = {
        id: 'pay-002',
        referenceNumber: 'NO-MATCH-REF',
        senderClabe: '012345678901234567',
        amount: 3500,
        receivedAt: '2026-03-17T14:00:00Z',
      };

      const result = await reconcilePayment(payment);

      expect(result.matched).toBe(true);
      expect(result.strategy).toBe('clabe_amount_match');
      expect(result.loanId).toBe('loan-clabe-001');

      // Verify transaction
      const loanUpdate = transactionUpdates.find((u) => u.path.includes('loans'));
      expect(loanUpdate).toBeDefined();
      expect(loanUpdate!.data.status).toBe('repaid');
      expect(loanUpdate!.data.reconciliationStrategy).toBe('clabe_amount_match');

      // Verify notification
      const pushed = __getPushed();
      expect(pushed.length).toBeGreaterThanOrEqual(1);
      const notification = JSON.parse(pushed[0][1]);
      expect(notification.type).toBe('loan_repaid');
      expect(notification.userId).toBe('user-xyz');
    });

    it('should skip CLABE strategy when no senderClabe provided', async () => {
      // Reference provided but misses, no CLABE → manual review
      queryResults = [makeQuerySnap([])];

      const payment: IncomingPayment = {
        id: 'pay-no-clabe',
        referenceNumber: 'UNKNOWN-REF',
        amount: 2000,
        receivedAt: '2026-03-17T12:00:00Z',
      };

      const result = await reconcilePayment(payment);

      expect(result.matched).toBe(false);
      expect(result.strategy).toBe('manual_review');
    });
  });

  // ── Strategy 3: flag for manual review ───────────────────────────────

  describe('Strategy 3: flag for manual review', () => {
    it('should flag unmatched payment for manual review', async () => {
      // Both strategies miss
      queryResults = [makeQuerySnap([]), makeQuerySnap([])];

      const payment: IncomingPayment = {
        id: 'pay-003',
        referenceNumber: 'ORPHAN-REF',
        senderClabe: '999888777666555444',
        amount: 7500,
        receivedAt: '2026-03-17T16:00:00Z',
        rawPayload: { originalEvent: 'stp_incoming' },
      };

      const result = await reconcilePayment(payment);

      expect(result.matched).toBe(false);
      expect(result.strategy).toBe('manual_review');
      expect(result.loanId).toBeUndefined();

      // Verify manual_review document created
      const reviewDoc = addedDocs.find((d) => d.collection === 'manual_review');
      expect(reviewDoc).toBeDefined();
      expect(reviewDoc!.data.paymentId).toBe('pay-003');
      expect(reviewDoc!.data.amount).toBe(7500);
      expect(reviewDoc!.data.senderClabe).toBe('999888777666555444');
      expect(reviewDoc!.data.referenceNumber).toBe('ORPHAN-REF');
      expect(reviewDoc!.data.status).toBe('pending');
      expect(reviewDoc!.data.rawPayload).toEqual({ originalEvent: 'stp_incoming' });

      // No notification should be pushed for unmatched
      const pushed = __getPushed();
      expect(pushed).toHaveLength(0);
    });

    it('should include null fields when optional data is missing', async () => {
      queryResults = [];

      const payment: IncomingPayment = {
        id: 'pay-minimal',
        amount: 100,
        receivedAt: '2026-03-17T10:00:00Z',
      };

      const result = await reconcilePayment(payment);

      expect(result.strategy).toBe('manual_review');

      const reviewDoc = addedDocs.find((d) => d.collection === 'manual_review');
      expect(reviewDoc).toBeDefined();
      expect(reviewDoc!.data.referenceNumber).toBeNull();
      expect(reviewDoc!.data.senderClabe).toBeNull();
      expect(reviewDoc!.data.rawPayload).toBeNull();
    });
  });

  // ── Priority ordering ────────────────────────────────────────────────

  describe('strategy priority', () => {
    it('should prefer reference match over CLABE match', async () => {
      const loanDoc = makeLoanDoc('loan-priority', {
        status: 'disbursed',
        employerId: 'emp-p',
        userId: 'user-p',
        stpReferenceNumber: 'PRIO-REF',
        employerClabe: '111222333444555666',
        repaymentAmount: 4000,
      });

      // First query (reference) matches immediately
      queryResults = [makeQuerySnap([loanDoc])];

      __setMockData('loans/loan-priority', {
        userId: 'user-p',
        employerId: 'emp-p',
        status: 'disbursed',
      });

      const payment: IncomingPayment = {
        id: 'pay-prio',
        referenceNumber: 'PRIO-REF',
        senderClabe: '111222333444555666',
        amount: 4000,
        receivedAt: '2026-03-17T18:00:00Z',
      };

      const result = await reconcilePayment(payment);

      // Should use reference_match, not clabe_amount_match
      expect(result.strategy).toBe('reference_match');
      expect(result.matched).toBe(true);
    });
  });
});
