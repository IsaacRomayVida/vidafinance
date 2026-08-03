/**
 * Tests for migration 003's page processor, against a Firestore double.
 *
 * The pure-function tests next door cover WHICH action each loan gets. These
 * cover the part that cannot be expressed as a pure function and is the whole
 * safety argument for the migration: the COPY IS DURABLY COMMITTED BEFORE THE
 * DELETE IS EVEN ISSUED. If that ordering ever inverts, a failed copy silently
 * destroys the only record of why a loan was decided.
 *
 * No Firebase app is initialised and no network call is made — `processPage`
 * takes its Firestore handle as an argument, and `FieldValue.serverTimestamp()`
 * / `FieldValue.delete()` are inert sentinels that need no live connection.
 */

import type { Firestore } from 'firebase-admin/firestore';

import {
  processPage,
  type Candidate,
  type Skip,
  type Tally,
} from '../003_move_underwriting_decision';

interface Commit {
  kind: 'copy' | 'delete';
  ids: string[];
}

interface FakeConfig {
  /** loanId → the data currently at `.../underwritingDetail/detail`. */
  details?: Record<string, unknown>;
  failCopyCommit?: boolean;
  failDeleteCommit?: boolean;
  /** loanIds whose individual fallback `update()` should throw. */
  failDeleteFor?: string[];
}

function makeDb(config: FakeConfig = {}) {
  const commits: Commit[] = [];
  const individualDeletes: string[] = [];
  const written: Record<string, Record<string, unknown>> = {};
  let getAllCalls = 0;

  const loanRef = (loanId: string) => ({
    __loanId: loanId,
    collection: () => ({ doc: () => ({ __detailFor: loanId }) }),
    update: async () => {
      if (config.failDeleteFor?.includes(loanId)) {
        throw new Error(`NOT_FOUND: no document to update: loans/${loanId}`);
      }
      individualDeletes.push(loanId);
    },
  });

  const db = {
    collection: () => ({ doc: loanRef }),

    getAll: async (...refs: Array<{ __detailFor: string }>) => {
      getAllCalls++;
      return refs.map((ref) => {
        const data = config.details?.[ref.__detailFor];
        return { exists: data !== undefined, data: () => data };
      });
    },

    batch: () => {
      const sets: string[] = [];
      const updates: string[] = [];
      return {
        set: (ref: { __detailFor: string }, data: Record<string, unknown>) => {
          sets.push(ref.__detailFor);
          written[ref.__detailFor] = data;
        },
        update: (ref: { __loanId: string }) => {
          updates.push(ref.__loanId);
        },
        commit: async () => {
          // A real batch is all-or-nothing, and this one only ever holds one
          // kind of operation — the migration never mixes them.
          if (sets.length > 0) {
            if (config.failCopyCommit) throw new Error('copy commit failed');
            commits.push({ kind: 'copy', ids: sets });
          }
          if (updates.length > 0) {
            if (config.failDeleteCommit) throw new Error('delete commit failed');
            commits.push({ kind: 'delete', ids: updates });
          }
        },
      };
    },
  };

  return {
    db: db as unknown as Firestore,
    commits,
    individualDeletes,
    written,
    getAllCalls: () => getAllCalls,
  };
}

function candidate(loanId: string, inline?: Record<string, unknown>): Candidate {
  return {
    loanId,
    inline: inline ?? {
      decision: 'approve',
      reason: 'all conditions passed',
      allPass: true,
      conditions: [{ name: 'bureau_score_min', pass: true, value: 712, bound: 640 }],
    },
  };
}

function newTally(): Tally {
  return { scanned: 0, copied: 0, deleted: 0, alreadyMigrated: 0 };
}

// The migration's DRY_RUN is read from process.argv at import. Under jest that
// never contains --dry-run, so these exercise the real write path. Assert it
// rather than assume it — a dry run here would make every test below vacuous.
beforeAll(() => {
  expect(process.argv).not.toContain('--dry-run');
});

// The migration is deliberately chatty; keep the suite output readable.
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('processPage — copy/delete ordering', () => {
  it('commits the copy BEFORE the delete', async () => {
    const fake = makeDb();
    const tally = newTally();

    await processPage(fake.db, [candidate('loan_1')], tally, []);

    expect(fake.commits.map((c) => c.kind)).toEqual(['copy', 'delete']);
    expect(fake.commits[0].ids).toEqual(['loan_1']);
    expect(fake.commits[1].ids).toEqual(['loan_1']);
  });

  it('issues NO delete at all when the copy commit fails', async () => {
    // The single most important property in this file. A failed copy must leave
    // the inline field intact so a re-run can retry it.
    const fake = makeDb({ failCopyCommit: true });
    const tally = newTally();

    await expect(processPage(fake.db, [candidate('loan_1')], tally, [])).rejects.toThrow(
      'copy commit failed'
    );

    expect(fake.commits).toHaveLength(0);
    expect(fake.individualDeletes).toEqual([]);
    expect(tally.copied).toBe(0);
    expect(tally.deleted).toBe(0);
  });

  it('does not let one loan\'s failed copy delete a different loan\'s field', async () => {
    const fake = makeDb({ failCopyCommit: true });

    await expect(
      processPage(fake.db, [candidate('loan_1'), candidate('loan_2')], newTally(), [])
    ).rejects.toThrow();

    expect(fake.commits).toHaveLength(0);
    expect(fake.individualDeletes).toEqual([]);
  });
});

describe('processPage — what gets written', () => {
  it('writes the normalised detail shape, not the raw inline value', async () => {
    const fake = makeDb();

    await processPage(
      fake.db,
      [candidate('loan_1', { decision: 'approve', conditions: [{ name: 'x', pass: true }], extra: 1 })],
      newTally(),
      []
    );

    const doc = fake.written['loan_1'];
    expect(doc['decision']).toBe('approve');
    expect(doc['conditions']).toEqual([{ name: 'x', pass: true }]);
    expect(doc['legacyFields']).toEqual({ extra: 1 });
    expect(doc['_migrationTag']).toBe('003_move_underwriting_decision');
    expect(doc['migratedFrom']).toBe('loans/loan_1.underwritingDecision');
  });

  it('skips the copy entirely when a usable destination already exists', async () => {
    const fake = makeDb({
      details: { loan_1: { decision: 'deny', conditions: [{ name: 'live', pass: false }] } },
    });
    const tally = newTally();

    await processPage(fake.db, [candidate('loan_1')], tally, []);

    // The live #509 record is left exactly as it was; only the leak is removed.
    expect(fake.written).toEqual({});
    expect(fake.commits.map((c) => c.kind)).toEqual(['delete']);
    expect(tally.alreadyMigrated).toBe(1);
    expect(tally.copied).toBe(0);
    expect(tally.deleted).toBe(1);
  });

  it('copies the fresh loans and deletes from both, on a mixed page', async () => {
    const fake = makeDb({
      details: { loan_migrated: { conditions: [{ name: 'already', pass: true }] } },
    });
    const tally = newTally();

    await processPage(
      fake.db,
      [candidate('loan_fresh'), candidate('loan_migrated')],
      tally,
      []
    );

    expect(fake.commits).toEqual([
      { kind: 'copy', ids: ['loan_fresh'] },
      { kind: 'delete', ids: ['loan_fresh', 'loan_migrated'] },
    ]);
    expect(tally.copied).toBe(1);
    expect(tally.alreadyMigrated).toBe(1);
    expect(tally.deleted).toBe(2);
  });
});

describe('processPage — loans it refuses to touch', () => {
  it('reports a malformed inline value and writes nothing for it', async () => {
    const fake = makeDb();
    const skipped: Skip[] = [];
    const tally = newTally();

    await processPage(
      fake.db,
      [{ loanId: 'loan_bad', inline: null as unknown as Record<string, unknown> }],
      tally,
      skipped
    );

    expect(fake.commits).toEqual([]);
    expect(tally.deleted).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].loanId).toBe('loan_bad');
    expect(skipped[0].reason).toContain('null');
  });

  it('carries on with the rest of the page after a malformed document', async () => {
    // One bad document must not abort the run — the other loans are still
    // leaking and still need closing.
    const fake = makeDb();
    const skipped: Skip[] = [];
    const tally = newTally();

    await processPage(
      fake.db,
      [
        { loanId: 'loan_bad', inline: 'approve' as unknown as Record<string, unknown> },
        candidate('loan_good'),
      ],
      tally,
      skipped
    );

    expect(fake.commits).toEqual([
      { kind: 'copy', ids: ['loan_good'] },
      { kind: 'delete', ids: ['loan_good'] },
    ]);
    expect(skipped.map((s) => s.loanId)).toEqual(['loan_bad']);
  });

  it('leaves a conflicting loan completely alone and reports it', async () => {
    // Destination exists but holds no conditions while the source does: do not
    // clobber the destination, do not destroy the richer source.
    const fake = makeDb({ details: { loan_conflict: { decision: 'approve' } } });
    const skipped: Skip[] = [];
    const tally = newTally();

    await processPage(fake.db, [candidate('loan_conflict')], tally, skipped);

    expect(fake.written).toEqual({});
    expect(fake.commits).toEqual([]);
    expect(tally.deleted).toBe(0);
    expect(skipped[0].reason).toContain('needs a human');
  });
});

describe('processPage — resilience', () => {
  it('falls back to per-document deletes when the delete batch fails', async () => {
    // A batch is atomic, so one vanished loan would otherwise take its whole
    // page down and wedge every re-run at the same place.
    const fake = makeDb({ failDeleteCommit: true, failDeleteFor: ['loan_gone'] });
    const skipped: Skip[] = [];
    const tally = newTally();

    await processPage(
      fake.db,
      [candidate('loan_ok_a'), candidate('loan_gone'), candidate('loan_ok_b')],
      tally,
      skipped
    );

    expect(fake.individualDeletes).toEqual(['loan_ok_a', 'loan_ok_b']);
    expect(tally.deleted).toBe(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].loanId).toBe('loan_gone');
    // The copy landed, so the record is not lost — only the field removal failed.
    expect(skipped[0].reason).toContain('copied to');
  });

  it('still copies first even when the delete phase later degrades', async () => {
    const fake = makeDb({ failDeleteCommit: true });

    await processPage(fake.db, [candidate('loan_1')], newTally(), []);

    expect(fake.commits.map((c) => c.kind)).toEqual(['copy']);
    expect(fake.individualDeletes).toEqual(['loan_1']);
  });
});

describe('processPage — empty page', () => {
  it('never calls getAll with zero refs', async () => {
    // Firestore's getAll() throws on an empty argument list, which would turn a
    // page of loans that all happen to be migrated into a crash.
    const fake = makeDb();

    await processPage(fake.db, [], newTally(), []);

    expect(fake.getAllCalls()).toBe(0);
    expect(fake.commits).toEqual([]);
  });
});
