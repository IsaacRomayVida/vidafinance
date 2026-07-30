'use strict';

// Fixed values for this isolated app-under-test -- unconditional, since the
// test bodies below assert against the literal 'test-secret' header value
// and must not silently drift if a real INTERNAL_SECRET happens to be set
// in the environment (e.g. by CI for other jobs).
process.env.REGISTRY_DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vida_registry_test';
process.env.INTERNAL_SECRET = 'test-secret';

const request = require('supertest');
const { app, pool } = require('./index');
const { resetLedgerTestState } = require('../shared/registry/testUtils');

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetLedgerTestState(pool);
});

test('rejects requests without the internal secret', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .send({ system: 'firebase', externalId: 'uid-1', kind: 'worker' });
  expect(res.status).toBe(401);
});

test('resolves-or-creates an entity and is idempotent', async () => {
  const first = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-1', kind: 'worker', displayName: 'Test Worker' });
  expect(first.status).toBe(200);
  expect(first.body.entityId).toBeDefined();

  const second = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-1', kind: 'worker', displayName: 'Test Worker' });
  expect(second.body.entityId).toBe(first.body.entityId);
});

test('400s when required fields are missing', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase' });
  expect(res.status).toBe(400);
});

test('attaches an additional ref to an existing entity', async () => {
  const resolved = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-2', kind: 'worker' });
  const entityId = resolved.body.entityId;

  const refRes = await request(app)
    .post(`/internal/entities/${entityId}/refs`)
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: 'ABCD800101XXX' });
  expect(refRes.status).toBe(200);

  const byRfc = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: 'ABCD800101XXX', kind: 'worker' });
  expect(byRfc.body.entityId).toBe(entityId);
});

test('health reports db connectivity', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body.db).toBe(true);
});

test('resolve with refs attaches all refs to the entity in one call', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({
      system: 'firebase',
      externalId: 'uid-batched',
      kind: 'worker',
      refs: [
        { system: 'rfc', externalId: 'BATC800101XXX' },
        { system: 'curp', externalId: 'BATC800101HDFRRL03' },
      ],
    });
  expect(res.status).toBe(200);
  const entityId = res.body.entityId;

  const viaRfc = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: 'BATC800101XXX', kind: 'worker' });
  expect(viaRfc.body.entityId).toBe(entityId);

  const viaCurp = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'curp', externalId: 'BATC800101HDFRRL03', kind: 'worker' });
  expect(viaCurp.body.entityId).toBe(entityId);
});

test('a ref conflict inside a batched resolve rolls back the whole transaction -- no partial rows', async () => {
  // Pre-seed a ref pointing at a different entity so the batch below collides.
  const seed = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-seed', kind: 'worker' });
  await request(app)
    .post(`/internal/entities/${seed.body.entityId}/refs`)
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: 'CONF800101XXX' });

  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({
      system: 'firebase',
      externalId: 'uid-conflicting-batch',
      kind: 'worker',
      refs: [{ system: 'rfc', externalId: 'CONF800101XXX' }],
    });
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({
    error: 'ref_conflict',
    system: 'rfc',
    externalId: 'CONF800101XXX',
    existingEntityId: seed.body.entityId,
  });

  // Nothing from the failed batch member should have been created --
  // neither the new entity nor a firebase ref for uid-conflicting-batch.
  const lookup = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-conflicting-batch', kind: 'worker' });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM entities');
  // The lookup call above creates its own fresh entity (resolve is
  // create-if-missing) -- assert it's a NEW entity, distinct from the seed,
  // proving the earlier failed transaction left no row behind to find.
  expect(lookup.body.entityId).not.toBe(seed.body.entityId);
  expect(rows[0].n).toBe(2);
});

test('addExternalRef route surfaces a conflict as 409, not 500', async () => {
  const seed = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-seed-2', kind: 'worker' });
  await request(app)
    .post(`/internal/entities/${seed.body.entityId}/refs`)
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'curp', externalId: 'ROUT800101HDFRRL04' });

  const other = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-other-2', kind: 'worker' });

  const conflict = await request(app)
    .post(`/internal/entities/${other.body.entityId}/refs`)
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'curp', externalId: 'ROUT800101HDFRRL04' });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error).toBe('ref_conflict');
  expect(conflict.body.existingEntityId).toBe(seed.body.entityId);
  expect(conflict.body.requestedEntityId).toBe(other.body.entityId);
});

test('400s when externalId is a JSON number instead of a string', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: 12345, kind: 'worker' });
  expect(res.status).toBe(400);
});

test('400s when a ref inside refs[] has a non-string externalId', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({
      system: 'firebase',
      externalId: 'uid-bad-ref',
      kind: 'worker',
      refs: [{ system: 'rfc', externalId: 998877 }],
    });
  expect(res.status).toBe(400);
});

test('400s on the refs route when system or externalId is not a string', async () => {
  const seed = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'firebase', externalId: 'uid-seed-3', kind: 'worker' });

  const res = await request(app)
    .post(`/internal/entities/${seed.body.entityId}/refs`)
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: { nested: 'object' } });
  expect(res.status).toBe(400);
});

test('400s when a clabe externalId normalizes to empty (e.g. "N/A")', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'clabe', externalId: 'N/A', kind: 'employer' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('invalid_external_id');
});

test('400s when an rfc externalId is whitespace-only after trim', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({ system: 'rfc', externalId: '   ', kind: 'worker' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('invalid_external_id');
});

test('an invalid externalId inside the refs[] batch rolls back the whole resolve -- no entity created', async () => {
  const res = await request(app)
    .post('/internal/entities/resolve')
    .set('x-internal-secret', 'test-secret')
    .send({
      system: 'firebase',
      externalId: 'uid-batch-invalid-ref',
      kind: 'worker',
      refs: [{ system: 'clabe', externalId: 'N/A' }],
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('invalid_external_id');

  const lookup = await pool.query(
    "SELECT count(*)::int AS n FROM entity_refs WHERE system = 'firebase' AND external_id = 'uid-batch-invalid-ref'"
  );
  expect(lookup.rows[0].n).toBe(0);
});
