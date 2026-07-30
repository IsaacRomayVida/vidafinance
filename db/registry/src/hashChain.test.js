'use strict';

const { Pool } = require('pg');
const { appendReceipt, verifyChain, GENESIS_HASH, CURRENT_HASH_VERSION } = require('./hashChain');
const { resetLedgerTestState } = require('./testUtils');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vida_registry_test';

let pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetLedgerTestState(pool);
});

async function seedEntity(client, kind) {
  const { rows } = await client.query(
    'INSERT INTO entities (kind, display_name) VALUES ($1, $2) RETURNING id',
    [kind, `${kind}-test`]
  );
  return rows[0].id;
}

test('chain of receipts is gap-free and verifies end to end', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');

    await client.query('BEGIN');
    const r1 = await appendReceipt(client, {
      actorEntityId: actorId,
      action: 'loan.approve',
      idempotencyKey: 'k1',
    });
    await client.query('COMMIT');

    await client.query('BEGIN');
    const r2 = await appendReceipt(client, {
      actorEntityId: actorId,
      action: 'loan.deny',
      idempotencyKey: 'k2',
    });
    await client.query('COMMIT');

    expect(Number(r2.seq)).toBe(Number(r1.seq) + 1);
    expect(r1.hash.equals(GENESIS_HASH)).toBe(false);

    const result = await verifyChain(client);
    expect(result).toEqual({ ok: true });
  } finally {
    client.release();
  }
});

test('receipts table rejects UPDATE and DELETE', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');

    await client.query('BEGIN');
    const r1 = await appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' });
    await client.query('COMMIT');

    await expect(
      pool.query("UPDATE receipts SET action = 'tampered' WHERE seq = $1", [r1.seq])
    ).rejects.toThrow(/append-only/);

    await expect(pool.query('DELETE FROM receipts WHERE seq = $1', [r1.seq])).rejects.toThrow(
      /append-only/
    );
  } finally {
    client.release();
  }
});

test('receipts table rejects TRUNCATE even for the table owner', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');
    await client.query('BEGIN');
    await appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' });
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await expect(pool.query('TRUNCATE receipts CASCADE')).rejects.toThrow(/append-only/);
});

test('idempotency_key is unique', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');

    await client.query('BEGIN');
    await appendReceipt(client, {
      actorEntityId: actorId,
      action: 'payout.send',
      idempotencyKey: 'dup-key',
    });
    await client.query('COMMIT');

    await client.query('BEGIN');
    await expect(
      appendReceipt(client, { actorEntityId: actorId, action: 'payout.send', idempotencyKey: 'dup-key' })
    ).rejects.toThrow(/idempotency_key/);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('appendReceipt outside a transaction throws instead of silently dropping serialization', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');
    // No BEGIN: pg_advisory_xact_lock would otherwise release at statement
    // end and every ordering/uniqueness guarantee would silently evaporate.
    await expect(appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' })).rejects.toThrow(
      /must be called inside an open transaction/
    );
  } finally {
    client.release();
  }
});

test('two concurrent writers on separate connections never fork the chain', async () => {
  const actorId = await (async () => {
    const c = await pool.connect();
    try {
      return await seedEntity(c, 'agent');
    } finally {
      c.release();
    }
  })();

  const N = 8;
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendReceipt(client, {
          actorEntityId: actorId,
          action: 'loan.approve',
          idempotencyKey: `concurrent-${i}`,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    })
  );

  const client = await pool.connect();
  try {
    const result = await verifyChain(client);
    expect(result).toEqual({ ok: true });

    const { rows } = await client.query('SELECT seq, prev_hash FROM receipts ORDER BY seq ASC');
    expect(rows).toHaveLength(N);
    // Gap-free seq.
    rows.forEach((r, i) => expect(Number(r.seq)).toBe(i + 1));
    // No duplicate prev_hash -- receipts_prev_hash_unique would have raised
    // on INSERT if two writers had ever forked from the same predecessor.
    const prevHashes = rows.map((r) => r.prev_hash.toString('hex'));
    expect(new Set(prevHashes).size).toBe(prevHashes.length);
  } finally {
    client.release();
  }
});

test('verifyChain detects a corrupted row that bypassed appendReceipt', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');

    await client.query('BEGIN');
    const r1 = await appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' });
    await client.query('COMMIT');

    // The trigger only blocks UPDATE/DELETE/TRUNCATE, not a malformed
    // INSERT -- this exercises verifyChain as the independent defense for
    // that case. prev_hash must be the real predecessor's hash (r1.hash),
    // not a reused/duplicate value -- receipts_prev_hash_unique already
    // rejects that at INSERT time, so this simulates the more subtle bypass:
    // a correct prev_hash paired with a `hash` that doesn't actually match
    // what that row's content recomputes to.
    const bogusHash = Buffer.alloc(32, 7);
    await client.query(
      `INSERT INTO receipts (actor_entity_id, action, evidence, hash_version, prev_hash, hash)
       VALUES ($1, 'loan.approve', '{}', $2, $3, $4)`,
      [actorId, CURRENT_HASH_VERSION, r1.hash, bogusHash]
    );

    const result = await verifyChain(client);
    expect(result.ok).toBe(false);
  } finally {
    client.release();
  }
});

test('verifyChain detects a receipt whose ts was altered after the fact', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');
    await client.query('BEGIN');
    const r1 = await appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' });
    await client.query('COMMIT');

    // Bypass the row trigger the same way an operator with table-owner
    // access could -- proves ts is now inside the hashed payload (fix for
    // "timestamp is not integrity-protected"), not just a DB-defaulted
    // column that verification never looks at.
    await client.query('ALTER TABLE receipts DISABLE TRIGGER receipts_no_update_delete');
    try {
      await client.query("UPDATE receipts SET ts = ts - interval '30 days' WHERE seq = $1", [r1.seq]);
    } finally {
      await client.query('ALTER TABLE receipts ENABLE TRIGGER receipts_no_update_delete');
    }

    const result = await verifyChain(client);
    expect(result.ok).toBe(false);
  } finally {
    client.release();
  }
});

test('verifyChain reports a clear error for an unknown hash_version instead of misverifying', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');
    await client.query(
      `INSERT INTO receipts (actor_entity_id, action, evidence, hash_version, prev_hash, hash)
       VALUES ($1, 'loan.approve', '{}', 99, $2, $2)`,
      [actorId, GENESIS_HASH]
    );

    const result = await verifyChain(client);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown hash_version/);
  } finally {
    client.release();
  }
});

describe('canonicalJson rejects values that would silently diverge from stored jsonb', () => {
  const { canonicalJson } = require('./hashChain');

  test('accepts null, boolean, string, integer, nested object/array', () => {
    expect(() =>
      canonicalJson({ a: null, b: true, c: 'x', d: 100, e: { f: [1, 2, 3] } })
    ).not.toThrow();
  });

  test('rejects a Date', () => {
    expect(() => canonicalJson({ when: new Date() })).toThrow(/Date/);
  });

  test('rejects undefined', () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
  });

  test('rejects NaN and Infinity', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Infinity })).toThrow(/non-finite/);
  });

  test('rejects a non-integer number (money must be integer cents or a string)', () => {
    expect(() => canonicalJson({ amountMxn: 100.5 })).toThrow(/non-integer/);
  });

  test('rejects an object with a custom toJSON', () => {
    const withToJson = { toJSON: () => ({ ok: true }) };
    expect(() => canonicalJson({ v: withToJson })).toThrow(/toJSON/);
  });
});
