// #389 — two-person change control on the loan fee rate.
//
// One field here reprices every future loan and lands on a CONDUSEF-regulated
// contract, so the tests are written against the controls rather than the happy
// path: proposer != approver, TTL, single use, hard bounds on both write and
// approve, and an audit record committed in the same transaction as the change.

import { HttpsError } from 'firebase-functions/v2/https';

// ── Firestore double ─────────────────────────────────────────────────────────
// Path-keyed so config/loan and config/loan/proposals/<id> are distinguishable,
// with a transaction that records writes in order. Reads inside the transaction
// go through txn.get so the handler's read-before-write discipline is exercised.

interface StoredDoc {
  exists: boolean;
  data: Record<string, unknown>;
}

const store = new Map<string, StoredDoc>();
const writes: Array<{ op: 'set' | 'update'; path: string; data: Record<string, unknown> }> = [];
let autoId = 0;
let getShouldThrow: Error | null = null;

class MockTimestamp {
  constructor(public millis: number) {}
  static now() {
    return new MockTimestamp(FIXED_NOW_MS);
  }
  static fromMillis(ms: number) {
    return new MockTimestamp(ms);
  }
  static fromDate(d: Date) {
    return new MockTimestamp(d.getTime());
  }
  toMillis() {
    return this.millis;
  }
  toDate() {
    return new Date(this.millis);
  }
}

const FIXED_NOW_MS = Date.UTC(2026, 7, 2, 12, 0, 0);

function makeDocRef(path: string) {
  return {
    id: path.split('/').pop() as string,
    _path: path,
    _collection: path.split('/').slice(0, -1).join('/'),
    get: async () => {
      if (getShouldThrow) throw getShouldThrow;
      const entry = store.get(path);
      return { exists: entry?.exists ?? false, data: () => entry?.data };
    },
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string) {
  return {
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${++autoId}`}`),
  };
}

const mockDb = {
  collection: (name: string) => makeCollectionRef(name),
  runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
    const txn = {
      get: async (ref: { _path: string }) => {
        if (getShouldThrow) throw getShouldThrow;
        const entry = store.get(ref._path);
        return { exists: entry?.exists ?? false, data: () => entry?.data };
      },
      set: (ref: { _path: string }, data: Record<string, unknown>) => {
        writes.push({ op: 'set', path: ref._path, data });
        const existing = store.get(ref._path);
        store.set(ref._path, { exists: true, data: { ...(existing?.data ?? {}), ...data } });
      },
      update: (ref: { _path: string }, data: Record<string, unknown>) => {
        writes.push({ op: 'update', path: ref._path, data });
        const existing = store.get(ref._path);
        store.set(ref._path, { exists: true, data: { ...(existing?.data ?? {}), ...data } });
      },
    };
    return fn(txn);
  },
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
  Timestamp: MockTimestamp,
  FieldValue: { serverTimestamp: () => ({ _serverTimestamp: true }) },
}));

jest.mock('../../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
  proposeLoanConfigChange,
  approveLoanConfigChange,
  PROPOSAL_TTL_MS,
  MIN_REASON_LENGTH,
} from '../loanConfigAdmin';
import { LOAN_FEE_RATE, MAX_ALLOWED_FEE_RATE } from '../loanConfig';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<Record<string, unknown>>;

const propose = proposeLoanConfigChange as unknown as Handler;
const approve = approveLoanConfigChange as unknown as Handler;

const alice = { uid: 'alice-uid', token: { role: 'admin', email: 'alice@vida.mx' } };
const bob = { uid: 'bob-uid', token: { role: 'admin', email: 'bob@vida.mx' } };
const superAdmin = { uid: 'sa-uid', token: { role: 'super_admin', email: 'sa@vida.mx' } };

const REASON = 'Repricing approved by the credit committee on 2026-08-02.';

const CONFIG_PATH = 'config/loan';

beforeEach(() => {
  store.clear();
  writes.length = 0;
  autoId = 0;
  getShouldThrow = null;
  jest.clearAllMocks();
});

/** Runs a full propose → approve cycle and returns the proposal id. */
async function proposeAs(auth: unknown, feeRate: number, reason = REASON): Promise<string> {
  const result = await propose({ auth, data: { feeRate, reason } });
  return result['proposalId'] as string;
}

function proposalDoc(proposalId: string): Record<string, unknown> {
  return store.get(`${CONFIG_PATH}/proposals/${proposalId}`)?.data ?? {};
}

function auditRecords(): Array<Record<string, unknown>> {
  return writes.filter((w) => w.path.startsWith('audit_log/')).map((w) => w.data);
}

describe('proposeLoanConfigChange', () => {
  describe('authorization', () => {
    it('rejects an unauthenticated caller', async () => {
      await expect(propose({ data: { feeRate: 0.2, reason: REASON } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it.each([['employee'], ['employer_admin'], ['ops']])(
      'rejects role %s — pricing is not an ops action',
      async (role) => {
        await expect(
          propose({
            auth: { uid: 'x', token: { role, email: 'x@vida.mx' } },
            data: { feeRate: 0.2, reason: REASON },
          })
        ).rejects.toMatchObject({ code: 'permission-denied' });
      }
    );

    it('allows admin', async () => {
      const result = await propose({ auth: alice, data: { feeRate: 0.2, reason: REASON } });
      expect(result['proposalId']).toBeTruthy();
    });

    it('allows super_admin', async () => {
      const result = await propose({ auth: superAdmin, data: { feeRate: 0.2, reason: REASON } });
      expect(result['proposalId']).toBeTruthy();
    });
  });

  describe('input validation', () => {
    it('requires a reason', async () => {
      await expect(propose({ auth: alice, data: { feeRate: 0.2 } })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('rejects an empty reason', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: 0.2, reason: '' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a whitespace-only reason — trimmed before the length check', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: 0.2, reason: ' '.repeat(50) } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a token reason shorter than the minimum', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: 0.2, reason: 'x'.repeat(MIN_REASON_LENGTH - 1) } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects an unreasonably long reason', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: 0.2, reason: 'x'.repeat(5000) } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a non-numeric feeRate', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: '0.2', reason: REASON } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it.each([
      ['Infinity', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
    ])('rejects %s', async (_label, feeRate) => {
      await expect(
        propose({ auth: alice, data: { feeRate, reason: REASON } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a no-op proposal', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: LOAN_FEE_RATE, reason: REASON } })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });
  });

  describe('server-enforced bounds (not editable through any API)', () => {
    it('rejects the fat-finger 3.0 — 300%, not 30%', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: 3.0, reason: REASON } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(writes).toHaveLength(0);
    });

    it('rejects a negative rate', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: -0.01, reason: REASON } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a hair above the ceiling', async () => {
      await expect(
        propose({ auth: alice, data: { feeRate: MAX_ALLOWED_FEE_RATE + 0.0001, reason: REASON } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('accepts exactly the ceiling', async () => {
      const id = await proposeAs(alice, MAX_ALLOWED_FEE_RATE);
      expect(proposalDoc(id)['proposedFeeRate']).toBe(MAX_ALLOWED_FEE_RATE);
    });

    it('accepts exactly the floor', async () => {
      const id = await proposeAs(alice, 0);
      expect(proposalDoc(id)['proposedFeeRate']).toBe(0);
    });
  });

  describe('effect', () => {
    it('does NOT change the live config — a proposal is not a change', async () => {
      await proposeAs(alice, 0.2);

      expect(store.get(CONFIG_PATH)).toBeUndefined();
      expect(writes.some((w) => w.path === CONFIG_PATH)).toBe(false);
    });

    it('records proposer, reason, before/after and an expiry', async () => {
      const id = await proposeAs(alice, 0.2);
      const doc = proposalDoc(id);

      expect(doc).toMatchObject({
        status: 'pending',
        currentFeeRate: LOAN_FEE_RATE,
        proposedFeeRate: 0.2,
        reason: REASON,
        proposedBy: alice.uid,
        proposedByEmail: alice.token.email,
        approvedBy: null,
      });
      expect((doc['expiresAt'] as MockTimestamp).toMillis()).toBe(FIXED_NOW_MS + PROPOSAL_TTL_MS);
    });

    it('uses the live stored rate as the "before" value once one exists', async () => {
      store.set(CONFIG_PATH, { exists: true, data: { feeRate: 0.25 } });

      const id = await proposeAs(alice, 0.2);

      expect(proposalDoc(id)['currentFeeRate']).toBe(0.25);
    });

    it('writes an audit_log record in the same transaction as the proposal', async () => {
      const id = await proposeAs(alice, 0.2);

      const audits = auditRecords();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'config.proposeLoanConfigChange',
        actorUid: alice.uid,
        actorRole: 'admin',
        actorEmail: alice.token.email,
        targetId: id,
        before: { feeRate: LOAN_FEE_RATE },
        after: { feeRate: 0.2 },
      });
      expect((audits[0]['meta'] as Record<string, unknown>)['reason']).toBe(REASON);
    });

    it('writes to audit_log (snake_case) and never to the retired auditLogs collection', async () => {
      await proposeAs(alice, 0.2);

      expect(writes.some((w) => w.path.startsWith('audit_log/'))).toBe(true);
      expect(writes.some((w) => w.path.startsWith('auditLogs/'))).toBe(false);
    });

    it('refuses to propose against an out-of-bounds live rate rather than papering over it', async () => {
      store.set(CONFIG_PATH, { exists: true, data: { feeRate: 3.0 } });

      await expect(propose({ auth: alice, data: { feeRate: 0.2, reason: REASON } })).rejects.toThrow();
      expect(writes).toHaveLength(0);
    });
  });
});

describe('approveLoanConfigChange', () => {
  describe('authorization', () => {
    it('rejects an unauthenticated caller', async () => {
      const id = await proposeAs(alice, 0.2);
      await expect(approve({ data: { proposalId: id } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it.each([['employee'], ['ops']])('rejects role %s', async (role) => {
      const id = await proposeAs(alice, 0.2);
      await expect(
        approve({ auth: { uid: 'x', token: { role, email: 'x@vida.mx' } }, data: { proposalId: id } })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  describe('the two-person rule', () => {
    it('refuses to let the proposer approve their own proposal', async () => {
      const id = await proposeAs(alice, 0.2);
      writes.length = 0;

      await expect(approve({ auth: alice, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
      // and nothing at all was written
      expect(writes).toHaveLength(0);
      expect(store.get(CONFIG_PATH)).toBeUndefined();
    });

    it('is enforced on uid, not on email or role — a second session of the same person is still the same person', async () => {
      const id = await proposeAs(alice, 0.2);

      const aliceElsewhere = {
        uid: alice.uid,
        token: { role: 'super_admin', email: 'alice+ops@vida.mx' },
      };
      await expect(approve({ auth: aliceElsewhere, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('lets a different admin approve', async () => {
      const id = await proposeAs(alice, 0.2);

      const result = await approve({ auth: bob, data: { proposalId: id } });

      expect(result).toMatchObject({ proposalId: id, previousFeeRate: LOAN_FEE_RATE, feeRate: 0.2 });
    });
  });

  describe('effect', () => {
    it('is the ONLY thing that moves the live rate', async () => {
      const id = await proposeAs(alice, 0.2);
      expect(store.get(CONFIG_PATH)).toBeUndefined();

      await approve({ auth: bob, data: { proposalId: id } });

      expect(store.get(CONFIG_PATH)?.data).toMatchObject({
        feeRate: 0.2,
        updatedBy: bob.uid,
      });
    });

    it('marks the proposal approved with the approver and timestamp', async () => {
      const id = await proposeAs(alice, 0.2);
      await approve({ auth: bob, data: { proposalId: id } });

      expect(proposalDoc(id)).toMatchObject({
        status: 'approved',
        approvedBy: bob.uid,
        approvedByEmail: bob.token.email,
        appliedFromFeeRate: LOAN_FEE_RATE,
      });
    });

    it('writes an audit_log record with actor, before, after and the proposal reason', async () => {
      const id = await proposeAs(alice, 0.2);
      writes.length = 0;

      await approve({ auth: bob, data: { proposalId: id } });

      const audits = auditRecords();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'config.approveLoanConfigChange',
        actorUid: bob.uid,
        actorEmail: bob.token.email,
        targetId: id,
        before: { feeRate: LOAN_FEE_RATE },
        after: { feeRate: 0.2 },
      });
      const meta = audits[0]['meta'] as Record<string, unknown>;
      expect(meta['reason']).toBe(REASON);
      expect(meta['proposedBy']).toBe(alice.uid);
    });

    it('commits the config write, the proposal update and the audit record in one transaction', async () => {
      const id = await proposeAs(alice, 0.2);
      writes.length = 0;

      await approve({ auth: bob, data: { proposalId: id } });

      const paths = writes.map((w) => w.path);
      expect(paths).toContain(CONFIG_PATH);
      expect(paths).toContain(`${CONFIG_PATH}/proposals/${id}`);
      expect(paths.some((p) => p.startsWith('audit_log/'))).toBe(true);
    });

    it('a second approval of the same rate change moves the rate from the previous live value', async () => {
      const first = await proposeAs(alice, 0.2);
      await approve({ auth: bob, data: { proposalId: first } });

      const second = await proposeAs(bob, 0.25);
      const result = await approve({ auth: alice, data: { proposalId: second } });

      expect(result).toMatchObject({ previousFeeRate: 0.2, feeRate: 0.25 });
      expect(store.get(CONFIG_PATH)?.data['feeRate']).toBe(0.25);
    });
  });

  describe('single use', () => {
    it('rejects a replay of an already-approved proposal', async () => {
      const id = await proposeAs(alice, 0.2);
      await approve({ auth: bob, data: { proposalId: id } });

      await expect(approve({ auth: superAdmin, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('rejects an unknown proposal id', async () => {
      await expect(approve({ auth: bob, data: { proposalId: 'nope' } })).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('rejects a missing proposal id', async () => {
      await expect(approve({ auth: bob, data: {} })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });
  });

  describe('expiry', () => {
    it('rejects a proposal past its TTL and leaves the live rate untouched', async () => {
      const id = await proposeAs(alice, 0.2);
      const doc = store.get(`${CONFIG_PATH}/proposals/${id}`)!;
      doc.data['expiresAt'] = new MockTimestamp(FIXED_NOW_MS - 1);
      writes.length = 0;

      await expect(approve({ auth: bob, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'deadline-exceeded',
      });
      expect(writes).toHaveLength(0);
      expect(store.get(CONFIG_PATH)).toBeUndefined();
    });

    it('rejects a proposal expiring exactly now — the boundary is closed', async () => {
      const id = await proposeAs(alice, 0.2);
      store.get(`${CONFIG_PATH}/proposals/${id}`)!.data['expiresAt'] = new MockTimestamp(FIXED_NOW_MS);

      await expect(approve({ auth: bob, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'deadline-exceeded',
      });
    });

    it('rejects a proposal with no expiry rather than treating it as immortal', async () => {
      const id = await proposeAs(alice, 0.2);
      delete store.get(`${CONFIG_PATH}/proposals/${id}`)!.data['expiresAt'];

      await expect(approve({ auth: bob, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('the TTL is 24h', () => {
      expect(PROPOSAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('bounds are re-checked at approval time', () => {
    it('refuses a stored proposal that is out of the CURRENT bounds', async () => {
      // Simulates the ceiling being lowered in code after the proposal was
      // raised, or the proposal document being tampered with directly.
      const id = await proposeAs(alice, 0.2);
      store.get(`${CONFIG_PATH}/proposals/${id}`)!.data['proposedFeeRate'] = 3.0;
      writes.length = 0;

      await expect(approve({ auth: bob, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
      expect(writes).toHaveLength(0);
      expect(store.get(CONFIG_PATH)).toBeUndefined();
    });

    it('refuses a proposal whose proposedFeeRate is not a number', async () => {
      const id = await proposeAs(alice, 0.2);
      store.get(`${CONFIG_PATH}/proposals/${id}`)!.data['proposedFeeRate'] = '0.2';

      await expect(approve({ auth: bob, data: { proposalId: id } })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });
  });
});

describe('HttpsError plumbing', () => {
  it('control-flow rejections reach the caller as HttpsError, not a generic 500', async () => {
    await expect(
      propose({ auth: alice, data: { feeRate: 3.0, reason: REASON } })
    ).rejects.toBeInstanceOf(HttpsError);
  });
});
