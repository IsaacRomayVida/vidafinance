// Marked as a module (`export {}`) so its top-level `const`/`class` declarations
// stay file-scoped. Without this a .test.ts with no top-level import/export is a
// global script, and two such files declaring the same name (`mockLogger`,
// `MockTimestamp`) fail to compile the moment both are on main — which is exactly
// how they broke the build when they first met.
export {};

// Regression test for the `onEmployerDocCreated` trigger in index.ts.
//
// This trigger mints the `employer_admin` custom claim — cross-employee reads,
// Storage payroll access and processPayroll. It is a privilege-escalation path,
// and it had no test at all: nothing pinned the ordering that makes it safe.
//
// Two properties are load-bearing and are what this file exists to protect:
//
//   1. The audit record is written BEFORE the claim is minted, so a failed audit
//      write aborts the grant. A grant that succeeds while its audit write fails
//      is worse than no grant at all: ops sees a privilege they cannot attribute.
//      The trigger must rethrow so the Cloud Functions runtime retries it.
//   2. The record lands in `audit_log` — the one collection firestore.rules
//      grants ops read on — and never in the retired camelCase `auditLogs`,
//      which no longer has a writer and which the ops console does not query.
//
// A reordering that mints first and logs second would still pass every other
// suite in this repo. That is the regression this file catches.

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

// Unlike the other index.ts suites, this one keeps the handler so it can be
// invoked directly — that is the whole point of the file.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn((_path: string, handler: unknown) => handler),
  onDocumentUpdated: jest.fn(() => jest.fn()),
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

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new MockTimestamp(0);
  }
  static fromDate(date: Date) {
    return new MockTimestamp(Math.floor(date.getTime() / 1000));
  }
  toDate() {
    return new Date(this.seconds * 1000);
  }
}

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: {
    increment: jest.fn((n: number) => ({ _increment: n })),
    serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  },
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/rateLimiter', () => ({ checkRateLimit: jest.fn().mockResolvedValue(true) }));
jest.mock('../../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

/** Records the order of side effects so the audit-before-mint ordering is observable. */
let sequence: string[] = [];

function buildMockDb({ auditWriteFails = false } = {}) {
  const auditWrites: Array<Record<string, unknown>> = [];
  const collection = jest.fn((name: string) => {
    if (name !== 'audit_log') {
      throw new Error(`Unexpected collection: ${name}`);
    }
    return {
      add: jest.fn(async (docData: Record<string, unknown>) => {
        if (auditWriteFails) {
          sequence.push('audit_write_failed');
          throw new Error('audit_log unavailable');
        }
        sequence.push('audit_write');
        auditWrites.push(docData);
        return { id: `audit-${auditWrites.length}` };
      }),
    };
  });
  return { collection, auditWrites };
}

/** Minimal shape of the onDocumentCreated event the trigger reads. */
function makeEvent(uid: string, status: string | undefined) {
  return {
    params: { uid },
    data: { data: () => (status === undefined ? {} : { status }) },
  };
}

type Trigger = (e: ReturnType<typeof makeEvent>) => Promise<null>;

async function loadTrigger(): Promise<Trigger> {
  const mod = await import('../../index');
  return mod.onEmployerDocCreated as unknown as Trigger;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  sequence = [];
  mockSetCustomUserClaims.mockImplementation(async () => {
    sequence.push('claim_minted');
  });
  mockDb = buildMockDb();
});

describe('onEmployerDocCreated — audit before privilege', () => {
  it('writes the audit record BEFORE minting the employer_admin claim', async () => {
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-1', 'approved'));

    // The ordering, not merely the presence of both.
    expect(sequence).toEqual(['audit_write', 'claim_minted']);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('employer-1', {
      role: 'employer_admin',
    });
  });

  it('does NOT mint the claim when the audit write fails, and rethrows so the runtime retries', async () => {
    mockDb = buildMockDb({ auditWriteFails: true });
    const trigger = await loadTrigger();

    await expect(trigger(makeEvent('employer-2', 'approved'))).rejects.toThrow('audit_log unavailable');

    // The grant must not have happened. This is the invariant: no privilege is
    // escalated without a durable record of it.
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(sequence).toEqual(['audit_write_failed']);
  });

  it('records the grant in audit_log, never in the retired auditLogs collection', async () => {
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-3', 'active'));

    const collectionsUsed = mockDb.collection.mock.calls.map((c) => c[0]);
    expect(collectionsUsed).toContain('audit_log');
    expect(collectionsUsed).not.toContain('auditLogs');
  });

  it('writes a canonical audit document describing the grant', async () => {
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-4', 'approved'));

    expect(mockDb.auditWrites).toHaveLength(1);
    const record = mockDb.auditWrites[0] as Record<string, unknown>;
    expect(record['action']).toBe('employer.claimGrantedOnCreate');
    expect(record['targetId']).toBe('employer-4');
    expect(record['actorUid']).toBe('system');
    expect(record['after']).toEqual({ role: 'employer_admin' });
    expect(record['meta']).toMatchObject({ trigger: 'onEmployerDocCreated', status: 'approved' });
    // Set by buildAuditLogDocument from the action prefix — the field the ops
    // console filters on.
    expect(record['targetCollection']).toBe('employer');
  });

  it.each([['pending_verification'], ['rejected'], ['suspended']])(
    'withholds the claim — and writes no audit record — for status %s',
    async (status) => {
      const trigger = await loadTrigger();

      await trigger(makeEvent('employer-5', status));

      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
      expect(mockDb.auditWrites).toHaveLength(0);
      expect(sequence).toEqual([]);
    }
  );

  it('withholds the claim when the created document has no status at all', async () => {
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-6', undefined));

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(mockDb.auditWrites).toHaveLength(0);
  });
});
