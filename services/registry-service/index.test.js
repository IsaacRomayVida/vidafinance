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
