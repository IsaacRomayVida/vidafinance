'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const { register: metricsRegister } = require('../../shared/metrics');

// GET /metrics has no try/catch at all -- `res.end(await metricsRegister.metrics())`
// is the entire handler body. Express 4 does not catch a rejected promise from an
// async route handler, so if the collector throws (a broken custom collector, or a
// process-stats read failing under sandboxing), the request gets no response at
// all. Same defect class as the registry-service transaction fix (#524) and the
// payment-server webhook fix (#526), just a smaller shape: a single unguarded await
// instead of a whole try/catch/finally block.

test('GET /metrics exposes the Prometheus text body on the healthy path (control)', async () => {
  const res = await request(app).get('/metrics').timeout(2000);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
  expect(res.text).toMatch(/vida_/);
});

test('GET /metrics returns 500 instead of hanging when the collector rejects', async () => {
  const spy = jest
    .spyOn(metricsRegister, 'metrics')
    .mockRejectedValueOnce(new Error('collector exploded'));
  try {
    const res = await request(app).get('/metrics').timeout(2000);
    expect(res.status).toBe(500);
  } finally {
    spy.mockRestore();
  }
});
