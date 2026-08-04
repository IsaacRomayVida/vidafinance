import { guardReadAfterWrite as mockGuardReadAfterWrite } from '../../__mocks__/txReadAfterWrite';
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
jest.mock('../../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});
jest.mock('../../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

/** Records the order of side effects so the audit-before-mint ordering is observable. */
let sequence: string[] = [];

/**
 * A tiny in-memory Firestore covering the three collections this trigger now
 * touches: `audit_log` (the claim grant), and `employerCodes` + `employers`
 * (the join-code mint and its reservation).
 *
 * The two code registries are modelled for real rather than stubbed away,
 * because the property under test is that a minted code is reserved and unique
 * across BOTH of them — a stub that always says "free" would pass whatever the
 * mint did.
 */
function buildMockDb({ auditWriteFails = false, mintFails = false } = {}) {
  const auditWrites: Array<Record<string, unknown>> = [];
  /** code -> reservation document */
  const reservations = new Map<string, Record<string, unknown>>();
  /** employerId -> employer document */
  const employers = new Map<string, Record<string, unknown>>();

  const auditCollection = {
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

  function employerCodesCollection() {
    return {
      doc: (code: string) => ({ _kind: 'reservation' as const, code }),
    };
  }

  function employersCollection() {
    return {
      doc: (id: string) => ({ _kind: 'employer' as const, id }),
      where: (field: string, _op: string, value: string) => ({
        limit: () => ({ _kind: 'employerCodeQuery' as const, field, value }),
      }),
    };
  }

  const collection = jest.fn((name: string) => {
    if (name === 'audit_log') return auditCollection;
    if (name === 'employerCodes') return employerCodesCollection();
    if (name === 'employers') return employersCollection();
    throw new Error(`Unexpected collection: ${name}`);
  });

  type Ref =
    | { _kind: 'reservation'; code: string }
    | { _kind: 'employer'; id: string }
    | { _kind: 'employerCodeQuery'; field: string; value: string };

  const runTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    if (mintFails) throw new Error('firestore unavailable');
    const tx = {
      get: async (ref: Ref) => {
        if (ref._kind === 'reservation') {
          return { exists: reservations.has(ref.code) };
        }
        if (ref._kind === 'employerCodeQuery') {
          const taken = [...employers.values()].some((e) => e[ref.field] === ref.value);
          return { empty: !taken };
        }
        const doc = employers.get(ref.id);
        return { exists: doc !== undefined, data: () => doc };
      },
      create: (ref: Ref, data: Record<string, unknown>) => {
        if (ref._kind !== 'reservation') throw new Error('unexpected create');
        reservations.set(ref.code, data);
      },
      update: (ref: Ref, data: Record<string, unknown>) => {
        if (ref._kind !== 'employer') throw new Error('unexpected update');
        employers.set(ref.id, { ...(employers.get(ref.id) ?? {}), ...data });
      },
    };
    return fn(mockGuardReadAfterWrite(tx));
  });

  return { collection, runTransaction, auditWrites, reservations, employers };
}

/** Minimal shape of the onDocumentCreated event the trigger reads. */
function makeEvent(uid: string, status: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    params: { uid },
    data: { data: () => (status === undefined ? { ...extra } : { status, ...extra }) },
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

// ── The join code ────────────────────────────────────────────────────────────
//
// The employer join code used to be generated in the browser and written onto
// the employer document at signup: firestore.rules blocked it on UPDATE (which
// is why ensureEmployerCode exists) but not on CREATE.
//
// The code is public — it is on the employer's own roster screen and given to
// every employee they onboard — so a client that may choose one may choose a
// real company's. lookupEmployerByCode resolves a code with `.limit(1)` and no
// explicit order, i.e. by document id, so the squatter wins by re-registering
// until their uid sorts below the real employer's. Every employee who then
// typed that company's code wrote `employerId: <squatter uid>` onto their own
// record, and firestore.rules grants `isEmployerAdminOf(employerId)` a read on
// a bare uid match — no role claim — so the squatter could list the cohort and
// read each victim's name, CURP, RFC, date of birth, phone, bank CLABE and
// salary, plus their loans via getEmployerDashboard.
//
// The namespace is server-owned now. These tests pin that.
describe('onEmployerDocCreated — join code', () => {
  it('mints a code for a self-serve employer, which never gets the claim', async () => {
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-selfserve', 'pending_verification'));

    // The status that withholds employer_admin is exactly the status a
    // self-signup lands in, so the mint must not sit behind the claim gate.
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();

    const minted = mockDb.employers.get('employer-selfserve')?.['employerCode'] as string;
    expect(minted).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    // Reserved in the same transaction, which is what makes it unique rather
    // than merely unlikely to collide.
    expect(mockDb.reservations.get(minted)).toMatchObject({ employerId: 'employer-selfserve' });
  });

  it('never issues a code another employer already holds', async () => {
    const trigger = await loadTrigger();

    // Every candidate but the last collides — the first with a reservation, the
    // second with a legacy employer document that predates the ledger and is
    // therefore absent from it. Only checking the ledger would hand out 'BBBBBB'.
    mockDb.reservations.set('AAAAAA', { employerId: 'employer-a' });
    mockDb.employers.set('employer-b', { employerCode: 'BBBBBB' });
    const candidates = ['AAAAAA', 'BBBBBB', 'CCCCCC'];
    let next = 0;
    jest.spyOn(Math, 'random').mockImplementation(() => {
      // Drive generateEmployerCodeCandidate to emit the candidates in order:
      // each call picks one alphabet index, six calls per candidate.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = candidates[Math.min(Math.floor(next / 6), candidates.length - 1)];
      const index = alphabet.indexOf(code[next % 6]);
      next += 1;
      return index / alphabet.length;
    });

    try {
      await trigger(makeEvent('employer-c', 'pending_verification'));
    } finally {
      (Math.random as jest.Mock).mockRestore();
    }

    expect(mockDb.employers.get('employer-c')?.['employerCode']).toBe('CCCCCC');
    expect(mockDb.reservations.get('CCCCCC')).toMatchObject({ employerId: 'employer-c' });
  });

  it('leaves an admin-supplied code alone', async () => {
    const trigger = await loadTrigger();

    // firestore.rules still lets an ADMIN create an employer in any shape, code
    // included (the admin console seeds employers that way). Only the self-serve
    // path is constrained, so a code that is already there is authoritative.
    await trigger(makeEvent('employer-seeded', 'active', { employerCode: 'SEEDED' }));

    expect(mockDb.employers.has('employer-seeded')).toBe(false);
    expect(mockDb.reservations.size).toBe(0);
  });

  it('still grants the claim when the mint fails', async () => {
    mockDb = buildMockDb({ mintFails: true });
    const trigger = await loadTrigger();

    await trigger(makeEvent('employer-7', 'approved'));

    // A code is recoverable (EmployeeRoster's ensureEmployerCode backfill); a
    // claim withheld by a Firestore blip leaves an approved employer locked out
    // of their own console with no in-product remedy. The mint must not be able
    // to take the grant down with it.
    expect(sequence).toEqual(['audit_write', 'claim_minted']);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to mint employer join code',
      expect.objectContaining({ uid: 'employer-7' })
    );
  });
});
