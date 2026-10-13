/**
 * `weeklyPortfolioSnapshot` rolls the whole `loans` collection up into one
 * weekly document — total active/overdue/paid counts, disbursed and
 * outstanding MXN, and an overdue rate. It had zero coverage, so nothing
 * pinned the status-bucketing (which spellings count as "disbursed" or
 * "repaid" — see `loanStatus.ts`), the outstanding-vs-disbursed distinction,
 * or the empty-portfolio division-by-zero guard.
 *
 * Note (per this source file's own header comment): this copy is NOT what's
 * deployed — the live function is the inline copy in index.ts, kept in
 * lockstep with this one. These tests exercise the module directly, as
 * asked; they do not assert anything about index.ts's wiring.
 *
 * `isDisbursedStatus`/`isRepaidStatus` are imported for real from
 * `../loans/loanStatus` (pure, dependency-free) rather than mocked, so the
 * bucketing here is checked against the actual status vocabulary.
 */
export {};

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));

const mockSnapshotSet = jest.fn(async (_data: Record<string, unknown>) => {});
const mockSnapshotDoc = jest.fn(() => ({ set: mockSnapshotSet }));
let mockLoanDocs: Array<{ data: () => Record<string, unknown> }> = [];
const mockLoansGet = jest.fn(async () => ({ docs: mockLoanDocs }));
const mockCollection = jest.fn((name: string) => {
  if (name === 'loans') return { get: mockLoansGet };
  if (name === 'portfolio_snapshots') return { doc: mockSnapshotDoc };
  throw new Error(`unexpected collection ${name}`);
});
const mockGetFirestore = jest.fn(() => ({ collection: mockCollection }));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockGetFirestore(),
  FieldValue: { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) },
}));

import { weeklyPortfolioSnapshot } from '../weeklyPortfolioSnapshot';

type Snapshot = {
  snapshotDate: string;
  totalActive: number;
  totalOverdue: number;
  totalPaid: number;
  totalDisbursedMXN: number;
  totalOutstandingMXN: number;
  overdueRate: number;
};

function loan(status: string, amount: number) {
  return { data: () => ({ status, amount }) };
}

async function run(): Promise<void> {
  return (weeklyPortfolioSnapshot as unknown as () => Promise<void>)();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoanDocs = [];
});

describe('weeklyPortfolioSnapshot', () => {
  it('buckets both disbursed spellings as active, sums totals, and computes an overdue rate', async () => {
    mockLoanDocs = [
      loan('active', 1000), // automatic-disbursement spelling
      loan('disbursed', 2000), // manual-ops-confirmed spelling
      loan('overdue', 500),
      loan('repaid', 3000),
      loan('paid', 1500), // legacy repaid alias — still counted
    ];

    await run();

    expect(mockSnapshotSet).toHaveBeenCalledTimes(1);
    const snap = mockSnapshotSet.mock.calls[0]?.[0] as Snapshot;

    expect(snap.totalActive).toBe(2); // active + disbursed
    expect(snap.totalOverdue).toBe(1);
    expect(snap.totalPaid).toBe(2); // repaid + legacy 'paid'
    expect(snap.totalOutstandingMXN).toBe(1000 + 2000 + 500); // excludes repaid
    expect(snap.totalDisbursedMXN).toBe(1000 + 2000 + 500 + 3000 + 1500); // lifetime, includes repaid
    expect(snap.overdueRate).toBeCloseTo(1 / 5);
  });

  it('does not divide by zero on an empty portfolio', async () => {
    mockLoanDocs = [];

    await run();

    const snap = mockSnapshotSet.mock.calls[0]?.[0] as Snapshot;
    expect(snap.totalActive).toBe(0);
    expect(snap.totalOverdue).toBe(0);
    expect(snap.totalPaid).toBe(0);
    expect(snap.overdueRate).toBe(0);
    expect(Number.isNaN(snap.overdueRate)).toBe(false);
  });

  it("writes the snapshot under today's date, and excludes a fully repaid loan from outstanding balance", async () => {
    mockLoanDocs = [loan('repaid', 9999)];

    await run();

    const today = new Date().toISOString().split('T')[0] as string;
    expect(mockSnapshotDoc).toHaveBeenCalledWith(today);

    const snap = mockSnapshotSet.mock.calls[0]?.[0] as Snapshot;
    expect(snap.snapshotDate).toBe(today);
    expect(snap.totalOutstandingMXN).toBe(0); // repaid debt is no longer outstanding
    expect(snap.totalDisbursedMXN).toBe(9999); // but still counts toward lifetime disbursed
  });

  it('ignores an unknown/dead status spelling for every bucket without throwing', async () => {
    mockLoanDocs = [loan('rejected', 4000), loan('cancelled', 1000)];

    await run();

    const snap = mockSnapshotSet.mock.calls[0]?.[0] as Snapshot;
    expect(snap.totalActive).toBe(0);
    expect(snap.totalOverdue).toBe(0);
    expect(snap.totalPaid).toBe(0);
    expect(snap.totalDisbursedMXN).toBe(0);
    expect(snap.overdueRate).toBe(0);
  });
});
