'use strict';

const { Pool } = require('pg');
const { resolveEntity, resolveOrCreateEntity, addExternalRef } = require('./resolver');
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

test('creates one entity for a new external ref and reuses it on repeat calls', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id1 = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-1',
      kind: 'worker',
      displayName: 'Test Worker',
    });
    await client.query('COMMIT');

    await client.query('BEGIN');
    const id2 = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-1',
      kind: 'worker',
      displayName: 'Test Worker',
    });
    await client.query('COMMIT');

    expect(id2).toBe(id1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM entities');
    expect(rows[0].n).toBe(1);
  } finally {
    client.release();
  }
});

test('concurrent resolveOrCreateEntity calls for the same ref never create two entities', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const id = await resolveOrCreateEntity(client, {
          system: 'firebase',
          externalId: 'uid-race',
          kind: 'worker',
        });
        await client.query('COMMIT');
        return id;
      } finally {
        client.release();
      }
    })
  );

  expect(new Set(attempts).size).toBe(1);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM entities');
  expect(rows[0].n).toBe(1);
});

test('addExternalRef attaches a second ref to the same entity', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entityId = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-2',
      kind: 'worker',
    });
    await addExternalRef(client, entityId, 'curp', 'CURP123456HDFRRL01');
    await client.query('COMMIT');

    const viaCurp = await resolveEntity(pool, 'curp', 'CURP123456HDFRRL01');
    expect(viaCurp).toBe(entityId);
  } finally {
    client.release();
  }
});

test('resolveEntity returns null for an unknown ref', async () => {
  const found = await resolveEntity(pool, 'firebase', 'no-such-uid');
  expect(found).toBeNull();
});

test('resolveOrCreateEntity outside a transaction throws instead of silently dropping serialization', async () => {
  const client = await pool.connect();
  try {
    await expect(
      resolveOrCreateEntity(client, { system: 'firebase', externalId: 'uid-no-tx', kind: 'worker' })
    ).rejects.toThrow(/must be called inside an open transaction/);
  } finally {
    client.release();
  }
});
