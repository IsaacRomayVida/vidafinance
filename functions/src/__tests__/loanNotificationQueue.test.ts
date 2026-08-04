// Regression tests for the notify-queue-routing defect: borrower loan
// approval/rejection notifications and the employer-approved email are
// silent no-ops in production because they call notify.ts's sendSMS/sendEmail
// directly, and TWILIO_*/SENDGRID_* secrets are only ever written onto the
// Railway `vida-notifications` worker (.github/workflows/railway-setup-env.yml)
// — never into functions/.env by deploy.yml or firebase-deploy.yml. The
// notification-service worker (services/notification-service/src/workers/
// notificationWorker.ts) already has switch cases for loan_approved,
// loan_rejected and employer_approved/employer_activated; the deployed
// Cloud Functions handlers just never enqueued a job for them.
//
// See this file's sibling `export {};` note in loanApprovalDisbursement.test.ts
// — this file has no top-level `import` before that line either, so it needs
// the same treatment (top-level `const`s in script-scoped files collide
// across files under typecheck:tests, which compiles every test file as one
// TS program).
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
  onDocumentUpdated: jest.fn((_path: unknown, handler: unknown) => handler),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(() => jest.fn()),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: mockLogger }));

const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);
jest.mock('firebase-admin', () => ({
  auth: jest.fn(() => ({ setCustomUserClaims: mockSetCustomUserClaims })),
}));

// notifyLoanEvent is the direct-send helper this defect routes AROUND. Kept
// mocked (not asserted-on-as-called) everywhere except the one test that
// proves it is no longer invoked for the events under test.
const mockNotifyLoanEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/notify', () => ({ notifyLoanEvent: (...a: unknown[]) => mockNotifyLoanEvent(...a) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' }) }));

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

interface StoreEntry {
  exists: boolean;
  data: Record<string, unknown>;
}

interface Write {
  collection: string;
  id: string;
  op: string;
  data: Record<string, unknown>;
}

function buildMockDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map<string, StoreEntry>();
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) {
      store.set(`${collection}/${id}`, { exists: true, data });
    }
  }

  const writes: Write[] = [];

  function makeDocRef(collection: string, id: string) {
    const key = `${collection}/${id}`;
    return {
      id,
      _key: key,
      get: jest.fn(async () => {
        const entry = store.get(key);
        return entry ? { exists: true, data: () => entry.data } : { exists: false, data: () => undefined };
      }),
      update: jest.fn(async (data: Record<string, unknown>) => {
        const prev = store.get(key)?.data ?? {};
        const merged = { ...prev, ...data };
        store.set(key, { exists: true, data: merged });
        writes.push({ collection, id, op: 'update', data });
      }),
    };
  }

  return {
    collection: jest.fn((name: string) => ({
      doc: jest.fn((id: string) => makeDocRef(name, id)),
      add: jest.fn(async (data: Record<string, unknown>) => {
        writes.push({ collection: name, id: 'generated', op: 'add', data });
        return { id: 'generated' };
      }),
    })),
    _store: store,
    _writes: writes,
  };
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
};

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
}));

const LOAN_BASE = {
  employeeId: 'emp-1',
  employeeName: 'Juan García',
  employerId: 'employer-1',
  employerName: 'Test Co',
  amount: 1000,
  employeePhone: '+525500000001',
  employeeEmail: 'juan@example.com',
};

type TriggerEvent = { params: { loanId: string }; data: { before: { data: () => unknown }; after: { data: () => unknown } } };

function statusChangeEvent(loanId: string, before: Record<string, unknown>, after: Record<string, unknown>): TriggerEvent {
  return {
    params: { loanId },
    data: {
      before: { data: () => ({ ...LOAN_BASE, ...before }) },
      after: { data: () => ({ ...LOAN_BASE, ...after }) },
    },
  };
}

async function loadOnLoanStatusChange() {
  const { onLoanStatusChange } = await import('../index');
  return onLoanStatusChange as unknown as (event: TriggerEvent) => Promise<unknown>;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

describe('onLoanStatusChange — loan_approved/loan_rejected must reach the borrower via the working queue path', () => {
  it('enqueues a loan_approved notification job on pending -> approved, matching the worker\'s NotificationJobData contract', async () => {
    mockDb = buildMockDb();
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const onLoanStatusChange = await loadOnLoanStatusChange();

    await onLoanStatusChange(statusChangeEvent('loan-1', { status: 'pending' }, { status: 'approved' }));

    const call = mockQueueAdd.mock.calls.find((c) => c[0] === 'loan_approved');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      type: 'loan_approved',
      loanId: 'loan-1',
      employeeId: 'emp-1',
      phone: '+525500000001',
      amount: 1000,
    });

    // The direct in-process sender is a permanent no-op in production
    // (TWILIO_*/SENDGRID_* are never set on the Firebase Functions runtime —
    // only on the Railway notification-service worker). It must not be
    // called any more for this event.
    expect(mockNotifyLoanEvent).not.toHaveBeenCalledWith('loan_approved', expect.anything());

    delete process.env['REDIS_URL'];
  });

  it('constructs the queue with retry/backoff defaultJobOptions, not the bare no-retry queue index.ts used to build inline', async () => {
    mockDb = buildMockDb();
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const onLoanStatusChange = await loadOnLoanStatusChange();

    await onLoanStatusChange(statusChangeEvent('loan-1', { status: 'pending' }, { status: 'approved' }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Queue } = require('bullmq') as { Queue: jest.Mock };
    expect(Queue).toHaveBeenCalledTimes(1);
    const opts = Queue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts['defaultJobOptions']).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });

    delete process.env['REDIS_URL'];
  });

  it('enqueues a loan_rejected notification job on under_review -> rejected, carrying the rejection reason from statusNote', async () => {
    mockDb = buildMockDb();
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const onLoanStatusChange = await loadOnLoanStatusChange();

    await onLoanStatusChange(
      statusChangeEvent('loan-2', { status: 'under_review' }, { status: 'rejected', statusNote: 'Bureau score too low' })
    );

    const call = mockQueueAdd.mock.calls.find((c) => c[0] === 'loan_rejected');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      type: 'loan_rejected',
      loanId: 'loan-2',
      employeeId: 'emp-1',
      phone: '+525500000001',
      amount: 1000,
      rejectionReason: 'Bureau score too low',
    });

    expect(mockNotifyLoanEvent).not.toHaveBeenCalledWith('loan_rejected', expect.anything());

    delete process.env['REDIS_URL'];
  });

  it('records an audit_log entry (not just a swallowed catch) when the queue is unavailable for an approval', async () => {
    mockDb = buildMockDb();
    delete process.env['REDIS_URL']; // getQueue throws synchronously: "REDIS_URL not configured"
    const onLoanStatusChange = await loadOnLoanStatusChange();

    await onLoanStatusChange(statusChangeEvent('loan-3', { status: 'pending' }, { status: 'approved' }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
    const failureAudit = mockDb._writes.find(
      (w) => w.collection === 'audit_log' && w.data['action'] === 'notification.enqueue_failed'
    );
    expect(failureAudit).toBeDefined();
    expect(failureAudit?.data['targetId']).toBe('loan-3');
    expect((failureAudit?.data['meta'] as Record<string, unknown>)['event']).toBe('loan_approved');
  });
});

describe('approveEmployer — employer_approved must not double-send against the already-working employer_activated queue job', () => {
  const mockEmployer = { companyName: 'Test Co', email: 'employer@example.com', name: 'Ana', employerCode: 'EMP123' };

  function buildEmployerDb() {
    const updateCalls: Array<Record<string, unknown>> = [];
    const employerDoc = {
      get: jest.fn().mockResolvedValue({ exists: true, data: () => mockEmployer }),
      update: jest.fn((data: Record<string, unknown>) => {
        updateCalls.push(data);
        return Promise.resolve();
      }),
    };
    const writes: Write[] = [];
    return {
      collection: jest.fn().mockImplementation((name: string) => {
        if (name === 'employers') {
          return { doc: jest.fn().mockReturnValue(employerDoc) };
        }
        if (name === 'audit_log') {
          return {
            add: jest.fn(async (data: Record<string, unknown>) => {
              writes.push({ collection: name, id: 'generated', op: 'add', data });
              return { id: 'audit-1' };
            }),
          };
        }
        throw new Error(`Unexpected collection: ${name}`);
      }),
      _updateCalls: updateCalls,
      _writes: writes,
    };
  }

  type ApproveEmployerFn = (req: { auth?: unknown; data: unknown }) => Promise<{ success: boolean; approved: boolean }>;

  it('sends exactly one employer-activation notification (via the queue), not a second direct-send duplicate', async () => {
    mockDb = buildEmployerDb() as unknown as ReturnType<typeof buildMockDb>;
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { approveEmployer } = await import('../index');
    const fn = approveEmployer as unknown as ApproveEmployerFn;

    await fn({ auth: { uid: 'admin-1', token: { role: 'admin' } }, data: { employerUid: 'employer-1', approved: true } });

    const activatedCalls = mockQueueAdd.mock.calls.filter((c) => c[0] === 'employer_activated');
    expect(activatedCalls).toHaveLength(1);
    expect(activatedCalls[0]?.[1]).toMatchObject({ email: 'employer@example.com', companyName: 'Test Co' });

    // The worker treats employer_approved and employer_activated as the SAME
    // case (services/notification-service/.../notificationWorker.ts:169-170),
    // so a second call — whether direct-send or a second enqueue — would be a
    // duplicate email to the same employer for the same event.
    expect(mockNotifyLoanEvent).not.toHaveBeenCalledWith('employer_approved', expect.anything());
    expect(mockQueueAdd.mock.calls.filter((c) => c[0] === 'employer_approved')).toHaveLength(0);

    delete process.env['REDIS_URL'];
  });
});
