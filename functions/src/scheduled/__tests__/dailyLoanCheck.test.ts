/**
 * Regression tests for two blind spots in the unattended daily arrears sweep:
 *
 *  - D1: the overdue sweep and the 24h reminder pass both hardcoded
 *    `status == 'active'`, so a loan disbursed through the manual
 *    ops-confirmed path (markLoanDisbursed, status `disbursed`) was invisible
 *    to both — it never went to `overdue` and never got a reminder.
 *  - D2: a failed (or unconfigured) SoftCrédito repayment sync left
 *    `repaymentSyncError` set but the overdue sweep ran anyway against that
 *    stale data, so a loan repaid by payroll but not yet synced got flipped
 *    to `overdue`, logged, and dunned — an infra hiccup manufacturing an
 *    adverse outcome against a borrower who already paid.
 *
 * See this file's sibling `export {};` note in loanApprovalDisbursement.test.ts
 * — this file has no top-level `import` before that line either, so it needs
 * the same treatment to get module scope (every test file in functions/src is
 * now compiled together as one TS program by typecheck:tests, and top-level
 * `const`s in script-scoped files collide across files with TS2451).
 */
export {};

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));

class MockTimestamp {
  constructor(private ms: number) {}
  static now() {
    return new MockTimestamp(Date.now());
  }
  static fromMillis(ms: number) {
    return new MockTimestamp(ms);
  }
  toMillis() {
    return this.ms;
  }
  toDate() {
    return new Date(this.ms);
  }
}

type Filter = { field: string; op: string; value: unknown };
type LoanDoc = Record<string, unknown>;

let mockLoans: Record<string, LoanDoc>;
let mockOverdueLog: Record<string, Record<string, unknown>>;
let mockSchedulerRuns: Array<Record<string, unknown>>;

function compare(actual: unknown, op: string, value: unknown): boolean {
  if (op === '==') return actual === value;
  if (op === 'in') return (value as unknown[]).includes(actual);
  if (op === '<') return (actual as MockTimestamp).toMillis() < (value as MockTimestamp).toMillis();
  throw new Error(`unsupported operator ${op}`);
}

function makeLoansQuery(filters: Filter[]): {
  where: (field: string, op: string, value: unknown) => ReturnType<typeof makeLoansQuery>;
  get: () => Promise<{ docs: unknown[]; size: number; empty: boolean }>;
} {
  return {
    where: (field: string, op: string, value: unknown) =>
      makeLoansQuery([...filters, { field, op, value }]),
    get: async () => {
      const docs = Object.entries(mockLoans)
        .filter(([, doc]) => filters.every((f) => compare(doc[f.field], f.op, f.value)))
        .map(([id, data]) => ({
          id,
          data: () => data,
          ref: {
            update: jest.fn(async (patch: Record<string, unknown>) => {
              mockLoans[id] = { ...mockLoans[id], ...patch };
            }),
          },
        }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'loans') return makeLoansQuery([]);
    if (name === 'overdue_log') {
      return {
        doc: (id: string) => ({
          set: jest.fn(async (data: Record<string, unknown>) => {
            mockOverdueLog[id] = data;
          }),
        }),
      };
    }
    if (name === 'scheduler_runs') {
      return {
        add: jest.fn(async (data: Record<string, unknown>) => {
          mockSchedulerRuns.push(data);
          return { id: 'run-1' };
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  Timestamp: MockTimestamp,
}));

const mockQueueAdd = jest.fn(async (_name: string, _payload: Record<string, unknown>) => {});
jest.mock('../../utils/queue', () => ({
  getQueue: jest.fn(() => ({ add: mockQueueAdd })),
}));

const mockAuditLog = jest.fn(async (_entry: Record<string, unknown>) => {});
jest.mock('../../utils/auditLog', () => ({
  auditLog: (entry: Record<string, unknown>) => mockAuditLog(entry),
}));

const mockFetch = jest.fn();

const LOAN_BASE = {
  employeeId: 'emp-1',
  employeeName: 'Juan García',
  employerId: 'employer-1',
  employeePhone: '555-0100',
  total: 1300,
};

function pastDueLoan(status: string, daysOverdue = 3): LoanDoc {
  return {
    ...LOAN_BASE,
    status,
    dueDate: MockTimestamp.fromMillis(Date.now() - daysOverdue * 86400000),
  };
}

async function loadHandler() {
  const { dailyLoanCheck } = await import('../dailyLoanCheck');
  return dailyLoanCheck as unknown as () => Promise<void>;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockLoans = {};
  mockOverdueLog = {};
  mockSchedulerRuns = [];
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ synced: 0 }) });
  process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://sc.example.test';
  process.env['INTERNAL_SECRET'] = 'test-secret';
});

afterEach(() => {
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  delete process.env['INTERNAL_SECRET'];
});

describe('D1 — manually-disbursed loans must not be invisible to the sweep', () => {
  it('flips a `disbursed` loan to overdue, not just `active` ones', async () => {
    mockLoans['loan-active'] = pastDueLoan('active');
    mockLoans['loan-disbursed'] = pastDueLoan('disbursed');

    const handler = await loadHandler();
    await handler();

    expect(mockLoans['loan-active']!['status']).toBe('overdue');
    expect(mockLoans['loan-disbursed']!['status']).toBe('overdue');
    expect(mockOverdueLog['loan-active']).toBeDefined();
    expect(mockOverdueLog['loan-disbursed']).toBeDefined();
  });

  it('sends the 24h reminder to a `disbursed` loan due tomorrow, not just `active`', async () => {
    mockLoans['loan-disbursed-soon'] = {
      ...LOAN_BASE,
      status: 'disbursed',
      dueDate: MockTimestamp.fromMillis(Date.now() + 5 * 3600000),
    };

    const handler = await loadHandler();
    await handler();

    const reminderCalls = mockQueueAdd.mock.calls.filter((c) => c[0] === 'loan_reminder_24h');
    expect(reminderCalls).toHaveLength(1);
    expect((reminderCalls[0]![1] as { loanId: string }).loanId).toBe('loan-disbursed-soon');
  });
});

describe('D2 — a stale/failed repayment sync must not dun a borrower who already paid', () => {
  it('does not mark loans overdue when the SoftCrédito sync call fails, and records the run as degraded', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    mockLoans['loan-1'] = pastDueLoan('active');

    const handler = await loadHandler();
    await handler();

    expect(mockLoans['loan-1']!['status']).toBe('active');
    expect(mockOverdueLog['loan-1']).toBeUndefined();
    expect(mockQueueAdd.mock.calls.some((c) => c[0] === 'loan_overdue')).toBe(false);
    expect(mockSchedulerRuns).toHaveLength(1);
    expect(mockSchedulerRuns[0]!['status']).toBe('degraded');
    expect(mockSchedulerRuns[0]!['repaymentSyncError']).toBe('HTTP 500');
  });

  it('also skips the sweep when SOFTCREDITO_ADAPTER_URL is unset, instead of running unchecked', async () => {
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    mockLoans['loan-1'] = pastDueLoan('active');

    const handler = await loadHandler();
    await handler();

    expect(mockLoans['loan-1']!['status']).toBe('active');
    expect(mockSchedulerRuns[0]!['status']).toBe('degraded');
    expect(mockSchedulerRuns[0]!['repaymentSyncError']).toBe('SOFTCREDITO_ADAPTER_URL not configured');
  });

  it('still runs the sweep, and reports a healthy run, when the sync succeeds', async () => {
    mockLoans['loan-1'] = pastDueLoan('active');

    const handler = await loadHandler();
    await handler();

    expect(mockLoans['loan-1']!['status']).toBe('overdue');
    expect(mockSchedulerRuns[0]!['status']).toBe('complete');
    expect(mockSchedulerRuns[0]!['repaymentSyncError']).toBeUndefined();
  });

  it('still sends the 24h reminder even when the sync fails — it is not an adverse action', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    mockLoans['loan-soon'] = {
      ...LOAN_BASE,
      status: 'active',
      dueDate: MockTimestamp.fromMillis(Date.now() + 5 * 3600000),
    };

    const handler = await loadHandler();
    await handler();

    expect(mockQueueAdd.mock.calls.some((c) => c[0] === 'loan_reminder_24h')).toBe(true);
  });
});
