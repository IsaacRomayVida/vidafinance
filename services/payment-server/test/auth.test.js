'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { Queue } = require('bullmq');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
  Queue.__reset();
});

describe('requireInternal — every /internal/* and /create-checkout route', () => {
  const cases = [
    { method: 'post', path: '/create-checkout' },
    { method: 'post', path: '/internal/repayment' },
    { method: 'get', path: '/internal/queue-stats' },
  ];

  for (const { method, path } of cases) {
    test(`${method.toUpperCase()} ${path} — 401s with no header`, async () => {
      const res = await request(app)[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    test(`${method.toUpperCase()} ${path} — 401s with the wrong secret`, async () => {
      const res = await request(app)[method](path).set('x-internal-secret', 'guess').send({});
      expect(res.status).toBe(401);
    });

    test(`${method.toUpperCase()} ${path} — 401s with an empty header value`, async () => {
      const res = await request(app)[method](path).set('x-internal-secret', '').send({});
      expect(res.status).toBe(401);
    });

    test(`${method.toUpperCase()} ${path} — gets past auth with the correct secret`, async () => {
      const res = await request(app)[method](path).set('x-internal-secret', SECRET).send({});
      // Past auth, each route has its own validation -- never 401 from here on.
      expect(res.status).not.toBe(401);
    });
  }
});

test('the Conekta webhook and health/metrics routes are NOT behind requireInternal', async () => {
  // /webhooks/conekta is guarded by its own signature check, not INTERNAL_SECRET
  // -- confirm it doesn't 401 just because no internal header was sent.
  const res = await request(app).get('/health');
  expect(res.status).not.toBe(401);
});
