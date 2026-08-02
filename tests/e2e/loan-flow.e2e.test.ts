/**
 * End-to-end coverage for the borrower loan-request flow, backed by a REAL
 * Firestore emulator — not a mocked Firestore. Firebase Cloud Functions
 * plumbing (onCall/onRequest/triggers/logger) is stubbed so `requestLoan`
 * and `getLoanConfig` (the deployed handlers in functions/src/index.ts) can
 * be invoked directly, but every Firestore read/write they perform hits the
 * emulator started by `npm run test:e2e:loan-flow` (see package.json and
 * firebase.e2e.json). No other Firestore module is mocked.
 *
 * Two P0s motivated this suite, and neither was caught by anything before it:
 *
 *   P0-1: every loan request threw "Plazo inválido" — the term the wizard
 *         submitted was never in the server-allowed set.
 *   P0-2: a borrower was quoted 8% and charged 30%. Per ADR-002 the fee rate
 *         has exactly one server-side source of truth
 *         (functions/src/config/loanConfig.ts).
 *
 * A related defect (#421): when that source of truth could not be read, the
 * wizard rendered a coherent, believable FREE loan with a 0% CAT — a false
 * statement in a field that is a mandatory regulated disclosure in Mexico.
 * CAT itself is computed client-side (public-v2/src/pages/LoanWizard.tsx,
 * pinned by LoanWizard.test.tsx) from the `feeRate` this suite's `getLoanConfig`
 * assertions exercise; see the "fee-rate read failure" describe block below
 * for exactly how the two are connected and what this suite can and can't see.
 */
import { getFirestore } from 'firebase-admin/firestore';
import {
  ALLOWED_LOAN_TERM_DAYS,
  LOAN_FEE_RATE,
  MAX_ALLOWED_FEE_RATE,
  LOAN_CONFIG_COLLECTION,
  LOAN_CONFIG_DOC_ID,
} from '../../functions/src/config/loanConfig';

// Only the Cloud Functions decorator layer is stubbed, exactly as
// functions/src/__tests__/requestLoan.test.ts does it: `onCall` normally
// returns an opaque CloudFunction, this makes it hand back the plain async
// handler so we can call it directly with `{ auth, data }`. Firestore itself
// is untouched — no jest.mock for 'firebase-admin/firestore' or
// 'firebase-admin/app' anywhere in this file.
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

type CallableRequest = { auth: { uid: string; token: Record<string, unknown> }; data: unknown };
type RequestLoanResult = { loanId: string; status: string; total: number; dueDate: string };
type GetLoanConfigResult = { feeRate: number; allowedTermDays: number[]; defaultTermDays: number };

let requestLoan: (req: CallableRequest) => Promise<RequestLoanResult>;
let getLoanConfig: (req: CallableRequest) => Promise<GetLoanConfigResult>;
let db: FirebaseFirestore.Firestore;

const PROJECT_ID = 'demo-vida-finance-test';
const EMULATOR_COLLECTIONS = ['employees', 'employers', 'loans', LOAN_CONFIG_COLLECTION, 'audit_log'];

function authFor(uid: string) {
  return { uid, token: { role: 'employee' } };
}

async function seedEligibleBorrower(uid: string) {
  const employerId = `employer-${uid}`;
  await db.collection('employers').doc(employerId).set({
    companyName: 'Test Company SA de CV',
    employerCode: 'TESTCO',
    status: 'active',
    riskTier: 2,
  });
  await db.collection('employees').doc(uid).set({
    name: 'Test Employee',
    email: `${uid}@vida-test.com`,
    employerId,
    employerName: 'Test Company SA de CV',
    availableCredit: 5000,
    monthlySalary: 20000, // 30% of this is 6000, comfortably above every amount used below
  });
}

async function clearEmulator() {
  for (const name of EMULATOR_COLLECTIONS) {
    await db.recursiveDelete(db.collection(name));
  }
}

beforeAll(async () => {
  // Never let a real network dependency (Redis, the UW/ML services, Slack,
  // Sentry) leak into this run — requestLoan is written to fail SOFT on all
  // of these (see functions/src/index.ts's try/catch around each), so
  // leaving them unset exercises exactly the "everything but Firestore is
  // down" path that a sandboxed test run actually is.
  delete process.env['REDIS_URL'];
  delete process.env['UNDERWRITING_SERVICE_URL'];
  delete process.env['INTERNAL_SECRET'];
  delete process.env['ML_SERVICE_URL'];
  delete process.env['SLACK_WEBHOOK_URL'];
  delete process.env['SENTRY_DSN'];

  // `firebase emulators:exec` (see package.json's test:e2e:loan-flow script)
  // exports FIRESTORE_EMULATOR_HOST for this process. Fall back to
  // firebase.e2e.json's configured port for a manually-started emulator.
  process.env['FIRESTORE_EMULATOR_HOST'] = process.env['FIRESTORE_EMULATOR_HOST'] || 'localhost:8098';
  process.env['GCLOUD_PROJECT'] = PROJECT_ID;
  process.env['GOOGLE_CLOUD_PROJECT'] = PROJECT_ID;

  // Dynamic import, not a static top-level one: TS/CJS hoists `import`
  // statements above plain code, which would call initializeApp() before
  // the env vars above are set. functions/src/__tests__/requestLoan.test.ts
  // uses the same technique for the same reason.
  const mod = await import('../../functions/src/index');
  requestLoan = mod.requestLoan as unknown as typeof requestLoan;
  getLoanConfig = mod.getLoanConfig as unknown as typeof getLoanConfig;

  db = getFirestore();
}, 30000);

afterEach(async () => {
  await clearEmulator();
});

afterAll(async () => {
  await db.terminate();
});

describe('happy path — every allowed term succeeds end to end (P0-1 regression)', () => {
  // Parameterised over the constant itself, not hardcoded day values —
  // hardcoding them is precisely how P0-1 (the wizard's term never matched
  // the server's allowed set) survived undetected.
  test.each(ALLOWED_LOAN_TERM_DAYS)('term=%i days is accepted and persisted', async (term) => {
    const uid = `employee-term-${term}`;
    await seedEligibleBorrower(uid);

    let error: unknown = null;
    let result: RequestLoanResult | undefined;
    try {
      result = await requestLoan({ auth: authFor(uid), data: { amount: 1000, termDays: term } });
    } catch (e) {
      error = e;
    }

    // The exact P0-1 regression: this must never be the failure reason for
    // a term that is actually in ALLOWED_LOAN_TERM_DAYS.
    expect(error).toBeNull();
    expect(result!.loanId).toBeTruthy();

    const loanDoc = await db.collection('loans').doc(result!.loanId).get();
    expect(loanDoc.exists).toBe(true);
    expect(loanDoc.data()?.['term']).toBe(term);
    expect(loanDoc.data()?.['employeeId']).toBe(uid);
  });
});

describe('term rejection', () => {
  it('rejects a term outside the server-allowed set, and creates no loan', async () => {
    const uid = 'employee-bad-term';
    await seedEligibleBorrower(uid);

    const rejectedTerm = 45;
    // Guard: if the allowed set ever grows to include 45, this test would
    // silently stop testing rejection. Fail loudly instead of quietly.
    expect(ALLOWED_LOAN_TERM_DAYS).not.toContain(rejectedTerm);

    await expect(
      requestLoan({ auth: authFor(uid), data: { amount: 1000, termDays: rejectedTerm } })
    ).rejects.toMatchObject({ code: 'invalid-argument', message: 'Plazo inválido' });

    const loans = await db.collection('loans').where('employeeId', '==', uid).get();
    expect(loans.empty).toBe(true);
  });
});

describe('fee rate is the server single source of truth (ADR-002, P0-2 regression)', () => {
  it('charges exactly the ratified 30% seed rate the borrower was quoted, with no config doc present', async () => {
    const uid = 'employee-fee-seed';
    await seedEligibleBorrower(uid);

    // The quote — what LoanWizard.tsx actually calls before rendering a
    // number to the borrower.
    const quote = await getLoanConfig({ auth: authFor(uid), data: {} });
    expect(quote.feeRate).toBe(LOAN_FEE_RATE); // 0.3 per ADR-002

    const amount = 1000;
    const result = await requestLoan({
      auth: authFor(uid),
      data: { amount, termDays: ALLOWED_LOAN_TERM_DAYS[0] },
    });

    // Assert against what the borrower was ACTUALLY quoted, not against the
    // LOAN_FEE_RATE constant a second time — a test that only compares a
    // constant to itself proves nothing (that's exactly how P0-2, the UI's
    // hardcoded second 8% literal, went unnoticed).
    const expectedFee = Math.round(amount * quote.feeRate);
    expect(result.total).toBe(amount + expectedFee);

    const loan = (await db.collection('loans').doc(result.loanId).get()).data()!;
    expect(loan['feeRate']).toBe(quote.feeRate);
    expect(loan['fee']).toBe(expectedFee);
    expect(loan['total']).toBe(amount + expectedFee);
  });

  it('follows an admin-approved rate change — charged rate matches the quote, not a hardcoded literal', async () => {
    const uid = 'employee-fee-custom';
    await seedEligibleBorrower(uid);

    // A rate other than the 30% seed. If quote and charge only ever agreed
    // because both sides hardcode the same literal, changing the single
    // source of truth here would break that illusion immediately.
    const customRate = 0.22;
    await db.collection(LOAN_CONFIG_COLLECTION).doc(LOAN_CONFIG_DOC_ID).set({ feeRate: customRate });

    const quote = await getLoanConfig({ auth: authFor(uid), data: {} });
    expect(quote.feeRate).toBe(customRate);

    const amount = 2000;
    const result = await requestLoan({
      auth: authFor(uid),
      data: { amount, termDays: ALLOWED_LOAN_TERM_DAYS[0] },
    });

    const expectedFee = Math.round(amount * quote.feeRate);
    expect(result.total).toBe(amount + expectedFee);

    const loan = (await db.collection('loans').doc(result.loanId).get()).data()!;
    expect(loan['feeRate']).toBe(customRate);
    expect(loan['fee']).toBe(expectedFee);
  });
});

describe('fee-rate read failure never renders a free loan (#421, fail-closed)', () => {
  // CAT (the regulated annual-cost disclosure) is computed entirely
  // client-side in LoanWizard.tsx from the `feeRate` returned by
  // getLoanConfig — see LoanWizard.tsx:234-241, and the guard at line 245
  // (`pricingReady = configStatus === 'ready' && feeRate !== null`) that
  // blocks every fee-derived render, CAT included, until a real rate has
  // loaded. This suite has no browser and cannot render that component, so
  // it cannot observe the "0%" on screen directly — that pixel-level
  // guarantee is LoanWizard.test.tsx's job. What it CAN and does assert is
  // the precondition that guarantee depends on: getLoanConfig must FAIL,
  // never resolve with a 0-or-fabricated feeRate — because the instant it
  // resolves, LoanWizard's feeRate stops being null, pricingReady flips
  // true, and every fee-derived figure (fee, total, and CAT) renders from a
  // rate nobody approved. That is the exact mechanism of #421.
  it('an out-of-bounds stored rate fails the quote AND the charge — never 0 fee, 0 total, or a fabricated rate', async () => {
    const uid = 'employee-fee-broken-oob';
    await seedEligibleBorrower(uid);
    await db
      .collection(LOAN_CONFIG_COLLECTION)
      .doc(LOAN_CONFIG_DOC_ID)
      .set({ feeRate: MAX_ALLOWED_FEE_RATE + 5 }); // fat-fingered, far past the hard ceiling

    // The quote must throw, not resolve — resolving with ANY feeRate here
    // (0, the bad value, or otherwise) is the bug.
    await expect(getLoanConfig({ auth: authFor(uid), data: {} })).rejects.toThrow();

    // The charge must fail closed too: no loan created at all, let alone one
    // priced at 0 or at the unapproved rate.
    await expect(
      requestLoan({ auth: authFor(uid), data: { amount: 1000, termDays: ALLOWED_LOAN_TERM_DAYS[0] } })
    ).rejects.toMatchObject({ code: 'internal' });

    const loans = await db.collection('loans').where('employeeId', '==', uid).get();
    expect(loans.empty).toBe(true);
  });

  it('a non-numeric stored rate is rejected the same way — never silently coerced to 0', async () => {
    const uid = 'employee-fee-broken-nan';
    await seedEligibleBorrower(uid);
    await db.collection(LOAN_CONFIG_COLLECTION).doc(LOAN_CONFIG_DOC_ID).set({ feeRate: 'free' });

    await expect(getLoanConfig({ auth: authFor(uid), data: {} })).rejects.toThrow();
    await expect(
      requestLoan({ auth: authFor(uid), data: { amount: 1000, termDays: ALLOWED_LOAN_TERM_DAYS[0] } })
    ).rejects.toMatchObject({ code: 'internal' });

    const loans = await db.collection('loans').where('employeeId', '==', uid).get();
    expect(loans.empty).toBe(true);
  });
});
