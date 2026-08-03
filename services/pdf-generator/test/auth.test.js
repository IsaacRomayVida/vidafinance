'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
});

describe('requireInternal — POST /contracts/generate', () => {
  test('401s with no header', async () => {
    const res = await request(app).post('/contracts/generate').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  test('401s with the wrong secret', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', 'guess')
      .send({});
    expect(res.status).toBe(401);
  });

  test('401s with an empty header value', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', '')
      .send({});
    expect(res.status).toBe(401);
  });

  test('gets past auth with the correct secret (still 400 — no loanId/employeeId)', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({});
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });
});

describe('health and metrics are NOT behind requireInternal', () => {
  test('GET /health does not 401 with no header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
  });

  test('GET /metrics does not 401 with no header', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).not.toBe(401);
  });
});
