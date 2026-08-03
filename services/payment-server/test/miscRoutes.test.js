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

test('GET /health reports ok when redis and firestore are reachable', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    status: 'ok',
    service: 'vida-payment-server',
    redis: true,
    firestore: true,
  });
  expect(res.body.queue_depth).toMatchObject({
    disbursements: 0,
    notifications: 0,
    pdfs: 0,
    underwriting: 0,
  });
});

test('GET /metrics exposes Prometheus text format', async () => {
  const res = await request(app).get('/metrics');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  expect(res.text).toMatch(/vida_/);
});

test('GET /internal/queue-stats returns per-queue counters behind auth', async () => {
  const res = await request(app).get('/internal/queue-stats').set('x-internal-secret', SECRET);
  expect(res.status).toBe(200);
  expect(Object.keys(res.body.queues)).toEqual(
    expect.arrayContaining(['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting']),
  );
  expect(res.body.queues['vida-disbursements']).toEqual({ waiting: 0, active: 0, failed: 0, completed: 0, delayed: 0 });
});
