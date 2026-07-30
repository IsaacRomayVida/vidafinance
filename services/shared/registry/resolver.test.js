'use strict';

const { Pool } = require('pg');
const {
  resolveEntity,
  resolveOrCreateEntity,
  addExternalRef,
  RefConflictError,
} = require('./resolver');
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

test('addExternalRef re-adding the same (system, externalId) to the same entity is a no-op', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entityId = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-noop',
      kind: 'worker',
    });
    await addExternalRef(client, entityId, 'curp', 'CURP123456HDFRRL02');
    await expect(addExternalRef(client, entityId, 'curp', 'CURP123456HDFRRL02')).resolves.toBeUndefined();
    await client.query('COMMIT');

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM entity_refs WHERE system = $1 AND external_id = $2',
      ['curp', 'CURP123456HDFRRL02']
    );
    expect(rows[0].n).toBe(1);
  } finally {
    client.release();
  }
});

test('addExternalRef throws RefConflictError when the ref already resolves to a different entity', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entityA = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-a',
      kind: 'worker',
    });
    await addExternalRef(client, entityA, 'curp', 'CURP999999HDFRRL09');
    await client.query('COMMIT');

    await client.query('BEGIN');
    const entityB = await resolveOrCreateEntity(client, {
      system: 'firebase',
      externalId: 'uid-b',
      kind: 'worker',
    });

    let caught;
    try {
      await addExternalRef(client, entityB, 'curp', 'CURP999999HDFRRL09');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RefConflictError);
    expect(caught.existingEntityId).toBe(entityA);
    expect(caught.requestedEntityId).toBe(entityB);
    expect(caught.system).toBe('curp');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('rfc normalization dedupes case and whitespace variants to one entity', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id1 = await resolveOrCreateEntity(client, {
      system: 'rfc',
      externalId: '  abcd800101xxx  ',
      kind: 'worker',
    });
    await client.query('COMMIT');

    await client.query('BEGIN');
    const id2 = await resolveOrCreateEntity(client, {
      system: 'rfc',
      externalId: 'ABCD800101XXX',
      kind: 'worker',
    });
    await client.query('COMMIT');

    expect(id2).toBe(id1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM entities');
    expect(rows[0].n).toBe(1);
  } finally {
    client.release();
  }
});

test('clabe normalization dedupes dash/space-formatted variants to the digits-only form', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id1 = await resolveOrCreateEntity(client, {
      system: 'clabe',
      externalId: '0121 8000-1234567890',
      kind: 'employer',
    });
    await client.query('COMMIT');

    const viaDigitsOnly = await resolveEntity(pool, 'clabe', '012180001234567890');
    expect(viaDigitsOnly).toBe(id1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM entities');
    expect(rows[0].n).toBe(1);
  } finally {
    client.release();
  }
});
