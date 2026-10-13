/**
 * Tests for migration 002 against an in-memory Firestore double.
 *
 * The two properties the runbook's sign-offs lean on are pinned here:
 *   - `--dry-run` writes NOTHING (not one batch is even created);
 *   - a re-run is idempotent: same destination ids, same contents, no new rows.
 * Plus the refusal to overwrite a native `audit_log` record, which must fire in
 * the dry run too so the rehearsal catches it.
 *
 * No Firebase app is initialised and no network call is made — `run` takes its
 * Firestore handle as an argument, and `Timestamp` is a plain value class.
 */

import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import { destinationId, normalise, run } from '../002_consolidate_audit_logs';

type Store = Record<string, Record<string, Record<string, unknown>>>;

function makeDb(seed: Store) {
  const store: Store = {};
  for (const [col, docs] of Object.entries(seed)) store[col] = { ...docs };
  let batchesCreated = 0;
  let commits = 0;

  const docRef = (col: string, id: string) => ({
    col,
    id,
    get: async () => {
      const data = store[col]?.[id];
      return { exists: data !== undefined, data: () => data };
    },
  });

  const db = {
    collection: (col: string) => ({
      get: async () => {
        const docs = Object.entries(store[col] ?? {}).map(([id, data]) => ({ id, data: () => data }));
        return { size: docs.length, empty: docs.length === 0, docs };
      },
      doc: (id: string) => docRef(col, id),
    }),
    batch: () => {
      batchesCreated++;
      const ops: Array<{ col: string; id: string; data: Record<string, unknown> }> = [];
      return {
        set: (ref: { col: string; id: string }, data: Record<string, unknown>) => {
          ops.push({ col: ref.col, id: ref.id, data });
        },
        commit: async () => {
          commits++;
          for (const op of ops) (store[op.col] ??= {})[op.id] = op.data;
        },
      };
    },
  } as unknown as Firestore;

  return { db, store, stats: () => ({ batchesCreated, commits }) };
}

const T1 = Timestamp.fromDate(new Date('2024-02-01T10:00:00Z'));
const T2 = Timestamp.fromDate(new Date('2024-03-15T18:30:00Z'));

function seed(): Store {
  return {
    auditLogs: {
      grant1: { action: 'admin.grant', actorUid: 'ops_1', targetId: 'user_9', role: 'ops', timestamp: T1 },
      revoke1: { action: 'admin.revoke', actorUid: 'ops_1', actorRole: 'super_admin', targetId: 'user_9', timestamp: T2 },
      noTs: { action: 'admin.grant', actorUid: 'ops_2', targetId: 'user_3' },
    },
    audit_log: {
      native1: { action: 'loans.disburse', timestamp: T2 },
    },
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = 0;
});

describe('migration 002 — dry run', () => {
  it('writes nothing and reports the same plan the real run executes', async () => {
    const fake = makeDb(seed());
    const before = JSON.stringify(fake.store);

    const plan = await run(fake.db, true);

    expect(fake.stats()).toEqual({ batchesCreated: 0, commits: 0 });
    expect(JSON.stringify(fake.store)).toBe(before);
    expect(plan.legacyCount).toBe(3);
    expect(plan.pending.map((p) => p.destId).sort()).toEqual(['legacy_grant1', 'legacy_revoke1']);
    expect(plan.skipped).toEqual([{ id: 'noTs', reason: 'missing or non-Timestamp `timestamp` field' }]);
    // Skips are a non-zero exit even in a dry run, so a scripted rehearsal fails loudly.
    expect(process.exitCode).toBe(1);
  });

  it('refuses a native-id collision in the dry run, before any real run is scheduled', async () => {
    const s = seed();
    s['audit_log']![destinationId('grant1')] = { action: 'native', timestamp: T1 };
    const fake = makeDb(s);

    await expect(run(fake.db, true)).rejects.toThrow(/Refusing to overwrite audit_log\/legacy_grant1/);
    expect(fake.stats().commits).toBe(0);
  });
});

describe('migration 002 — real run', () => {
  it('copies forward, preserves the original timestamp, never deletes the legacy rows', async () => {
    const fake = makeDb(seed());

    await run(fake.db, false);

    const copied = fake.store['audit_log']!['legacy_grant1']!;
    expect(copied['timestamp']).toBe(T1);
    expect(copied['action']).toBe('admin.grant');
    expect(copied['targetCollection']).toBe('admin');
    expect(copied['_migrationTag']).toBe('002_consolidate_audit_logs');
    expect(copied['meta']).toEqual({
      migratedFrom: 'auditLogs/grant1',
      migratedBy: '002_consolidate_audit_logs',
      legacyFields: { role: 'ops' },
    });
    expect(Object.keys(fake.store['auditLogs']!)).toHaveLength(3);
    expect(fake.store['audit_log']!['native1']).toEqual({ action: 'loans.disburse', timestamp: T2 });
    expect(fake.store['audit_log']!['legacy_noTs']).toBeUndefined();
  });

  it('is idempotent: a second run overwrites its own output and adds no rows', async () => {
    const fake = makeDb(seed());

    await run(fake.db, false);
    const afterFirst = JSON.stringify(fake.store);
    const countFirst = Object.keys(fake.store['audit_log']!).length;

    await run(fake.db, false);

    expect(Object.keys(fake.store['audit_log']!).length).toBe(countFirst);
    expect(JSON.stringify(fake.store)).toBe(afterFirst);
    expect(countFirst).toBe(3); // native1 + 2 migrated
  });
});

describe('normalise', () => {
  it('defaults missing fields instead of assuming them', () => {
    const doc = normalise('x', { timestamp: T1 });
    expect(doc).toMatchObject({
      action: 'legacy.unknown',
      actorUid: 'unknown',
      actorRole: 'unknown',
      actorEmail: null,
      targetId: '',
      before: null,
      after: null,
    });
  });
});
