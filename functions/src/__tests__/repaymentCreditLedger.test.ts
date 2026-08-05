/**
 * The borrower's credit hold is released by TWO channels that share one loan
 * document, and until this change only one of them kept a ledger of what it
 * had already released.
 *
 *  - `services/payment-server/applyRepayment.js` restores credit
 *    incrementally, on every partial payment, and records the running total on
 *    `loans.creditRestored`. It settles as `status: 'paid'`.
 *  - `processPayroll` (the employer CSV) restores nothing per deduction; the
 *    whole hold comes back from the `onLoanStatusChange` trigger, once, when a
 *    deduction takes the balance to zero and the loan goes `repaid`.
 *
 * The trigger incremented `availableCredit` by the loan's full `amount` with
 * no reference to `creditRestored`, so a loan partly repaid through
 * payment-server and then FINISHED by a payroll CSV had the already-restored
 * slice handed back a second time — borrowing power minted out of money the
 * borrower had merely repaid.
 *
 * This suite covers the DEPLOYED copy of the trigger, the one inline in
 * index.ts and named in deploy.yml's FUNCTIONS list. The non-deployed mirror
 * at loans/onLoanStatusChange.ts is covered by its own sibling suite, and the
 * arithmetic itself by loans/__tests__/loanStatus.test.ts.
 */
export {};

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  onRequest: jest.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  },
}));

// The gate condition and the arithmetic inside the trigger are the code under
// test, so hand the handler back rather than swallowing it.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(() => jest.fn()),
  onDocumentUpdated: jest.fn((_path: unknown, handler: unknown) => handler),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: jest.fn(() => jest.fn()) }));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: mockLogger }));

jest.mock('firebase-admin', () => ({
  auth: jest.fn(() => ({
    setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn(async (uid: string) => ({ uid })),
  })),
}));

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new MockTimestamp(0);
  }
  static fromDate(date: Date) {
    return new MockTimestamp(Math.floor(date.getTime() / 1000));
  }
  static fromMillis(ms: number) {
    return new MockTimestamp(Math.floor(ms / 1000));
  }
  toDate() {
    return new Date(this.seconds * 1000);
  }
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
};

interface Write {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

let mockWrites: Write[] = [];

const mockDb = {
  collection: jest.fn((name: string) => ({
    doc: jest.fn((id: string) => ({
      id,
      update: jest.fn(async (data: Record<string, unknown>) => {
        mockWrites.push({ collection: name, id, data });
      }),
      set: jest.fn(async () => {}),
      get: jest.fn(async () => ({ exists: false, data: () => undefined })),
    })),
    add: jest.fn(async () => ({ id: 'generated' })),
  })),
  runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ get: jest.fn(async () => ({ exists: false, data: () => undefined })), update: jest.fn(), set: jest.fn() })
  ),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
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
jest.mock('../utils/queue', () => ({
  getQueue: jest.fn(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
  recordNotificationEnqueueFailure: jest.fn().mockResolvedValue(undefined),
}));

type TriggerEvent = {
  params: { loanId: string };
  data: { before: { data: () => unknown }; after: { data: () => unknown } };
};

/**
 * A loan as `requestLoan` writes it: $5,000 principal at the 30% fee, so a
 * $6,500 obligation. `availableCredit` was reduced by the PRINCIPAL at
 * origination (`holdCredit`, index.ts), so $5,000 is the ceiling on what may
 * ever come back — restoring `total` would hand the fee back as new
 * borrowing power.
 */
const LOAN = {
  employeeId: 'emp-1',
  employerId: 'employer-1',
  amount: 5000,
  fee: 1500,
  total: 6500,
};

function repaymentEvent(after: Record<string, unknown>, beforeStatus = 'active'): TriggerEvent {
  return {
    params: { loanId: 'loan-1' },
    data: {
      before: { data: () => ({ ...LOAN, status: beforeStatus }) },
      after: { data: () => ({ ...LOAN, status: 'repaid', ...after }) },
    },
  };
}

async function loadTrigger() {
  const { onLoanStatusChange } = await import('../index');
  return onLoanStatusChange as unknown as (e: TriggerEvent) => Promise<unknown>;
}

const creditWrites = () =>
  mockWrites.filter((w) => w.collection === 'employees' && w.id === 'emp-1');

const creditRestored = () =>
  creditWrites().reduce(
    (sum, w) => sum + ((w.data['availableCredit'] as { _increment?: number })?._increment ?? 0),
    0
  );

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockWrites = [];
  delete process.env['REDIS_URL'];
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
});

describe('onLoanStatusChange — credit restoration on repayment (deployed copy in index.ts)', () => {
  // The pre-existing correct behaviour, and the overwhelmingly common one: a
  // loan repaid entirely through the payroll CSV never touches
  // `creditRestored`, so the whole principal is still owed back here.
  it('restores the full principal for a loan repaid only through payroll', async () => {
    const trigger = await loadTrigger();

    await trigger(repaymentEvent({}));

    expect(creditRestored()).toBe(5000);
    expect(mockWrites).toContainEqual(
      expect.objectContaining({ collection: 'employers', id: 'employer-1', data: { activeLoans: { _increment: -1 } } })
    );
  });

  // The defect. SoftCrédito reports a short deduction of $1,500 through
  // POST /internal/repayment; applyRepayment.js restores $1,500 of credit,
  // stamps `creditRestored: 1500`, and leaves the loan `active` because
  // $5,000 is still owed. The employer's next CSV upload deducts that $5,000
  // and processPayroll flips the loan to `repaid`. Before the fix this trigger
  // added another $5,000 on top of the $1,500 already returned — $6,500 of
  // borrowing power against a $5,000 hold.
  it('does not re-restore the slice payment-server already handed back', async () => {
    const trigger = await loadTrigger();

    await trigger(repaymentEvent({ creditRestored: 1500 }));

    expect(creditRestored()).toBe(3500);
  });

  // The overshoot scales with the other channel's share, so the worst case is
  // a loan almost entirely repaid off-payroll: $4,900 by card left only
  // $1,600 for the CSV to collect, and the borrower used to walk away with
  // $9,900 of credit against that same $5,000 hold — nearly double the line.
  it('caps the total restored at the principal when the other channel did most of the work', async () => {
    const trigger = await loadTrigger();

    await trigger(repaymentEvent({ creditRestored: 4900 }));

    expect(creditRestored()).toBe(100);
  });

  // Nothing left to release: skip the write entirely rather than incrementing
  // by zero. A card payment that restored the whole principal and left the
  // loan `active` (fee still outstanding) then settled by payroll lands here.
  it('writes nothing to the employee when the hold is already fully released', async () => {
    const trigger = await loadTrigger();

    await trigger(repaymentEvent({ creditRestored: 5000 }));

    expect(creditWrites()).toHaveLength(0);
    // The employer's origination slot is a separate counter and must still be
    // freed — this loan is done regardless of who released the credit.
    expect(mockWrites).toContainEqual(
      expect.objectContaining({ collection: 'employers', id: 'employer-1', data: { activeLoans: { _increment: -1 } } })
    );
  });

  // Still gated on the canonical 'repaid' spelling only: payment-server writes
  // 'paid' and does its own restoration in the same transaction.
  it('does not fire on -> paid, which payment-server counters itself', async () => {
    const trigger = await loadTrigger();

    await trigger({
      params: { loanId: 'loan-1' },
      data: {
        before: { data: () => ({ ...LOAN, status: 'active' }) },
        after: { data: () => ({ ...LOAN, status: 'paid', creditRestored: 5000 }) },
      },
    });

    expect(mockWrites).toHaveLength(0);
  });
});
