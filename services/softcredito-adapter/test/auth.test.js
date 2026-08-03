'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn().mockRejectedValue(new Error('scToken should not be called for a 401')),
  scTokenProbe: jest.fn(),
}));
jest.mock('../lib/fetchClient', () => ({
  getFetch: jest.fn().mockRejectedValue(new Error('fetch should not be called for a 401')),
}));

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
});

describe('requireInternal — every internal route', () => {
  const cases = [
    { method: 'post', path: '/internal/disburse' },
    { method: 'post', path: '/internal/register-employer' },
    { method: 'post', path: '/internal/register-deduction' },
    { method: 'post', path: '/internal/sync-repayments' },
    { method: 'post', path: '/bureau/query' },
    { method: 'post', path: '/curp/validate' },
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

test('the health, metrics and debug-routes endpoints are NOT behind requireInternal', async () => {
  const health = await request(app).get('/health');
  expect(health.status).not.toBe(401);

  const metrics = await request(app).get('/metrics');
  expect(metrics.status).not.toBe(401);

  const routes = await request(app).get('/debug-routes');
  expect(routes.status).not.toBe(401);
});
