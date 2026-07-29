'use strict';

const { Pool } = require('pg');
const { appendReceipt, verifyChain, GENESIS_HASH } = require('./hashChain');

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
  await pool.query(
    'TRUNCATE receipts, relationship_members, relationships, entity_refs, entities RESTART IDENTITY CASCADE'
  );
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

test('verifyChain detects a corrupted row that bypassed appendReceipt', async () => {
  const client = await pool.connect();
  try {
    const actorId = await seedEntity(client, 'agent');

    await client.query('BEGIN');
    await appendReceipt(client, { actorEntityId: actorId, action: 'loan.approve' });
    await client.query('COMMIT');

    // The trigger only blocks UPDATE/DELETE, not a malformed INSERT -- this
    // exercises verifyChain as the independent defense for that case.
    await client.query(
      `INSERT INTO receipts (actor_entity_id, action, evidence, prev_hash, hash)
       VALUES ($1, 'loan.approve', '{}', $2, $2)`,
      [actorId, GENESIS_HASH]
    );

    const result = await verifyChain(client);
    expect(result.ok).toBe(false);
  } finally {
    client.release();
  }
});
