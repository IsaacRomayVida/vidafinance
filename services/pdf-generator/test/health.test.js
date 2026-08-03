'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');

beforeEach(() => {
  admin.__reset();
});

test('GET /health reports ok when redis and firestore are reachable', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    status: 'ok',
    service: 'vida-pdf-generator',
    redis: true,
    firestore: true,
  });
  expect(res.body.queue_depth).toMatchObject({ pdfs: 0 });
});

test('GET /metrics exposes Prometheus text format', async () => {
  const res = await request(app).get('/metrics');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  expect(res.text).toMatch(/vida_/);
});
