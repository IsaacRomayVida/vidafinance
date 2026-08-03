'use strict';

// GET /metrics is an async Express 4 handler whose only statement is an
// unguarded `await`:
//
//     app.get('/metrics', async (req, res) => {
//       res.set('Content-Type', metricsRegister.contentType);
//       res.end(await metricsRegister.metrics());
//     });
//
// Express 4 does not catch a rejected promise from an async route handler, so
// if the registry rejects -- any registered collector throwing is enough --
// nothing ever calls res.end() and the scrape hangs until the client gives up.
// Same shape as the defects fixed in registry-service (#524) and
// payment-server (#526).

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn(),
}));
jest.mock('../lib/fetchClient', () => ({ getFetch: jest.fn() }));

const metricsModule = require('../../shared/metrics');
const metricsSpy = jest.spyOn(metricsModule.register, 'metrics');

const request = require('supertest');
const { app } = require('../index');

// Restore once, at the end. NOT in afterEach: mockRestore detaches the spy
// from the register object index.js captured at require time, so a later
// mockRejectedValueOnce would silently apply to nothing. jest.spyOn defaults
// to calling through to the real implementation, so the control test below
// still exercises the real registry.
afterAll(() => {
  metricsSpy.mockRestore();
});

describe('GET /metrics', () => {
  test('control: serves the registry in the Prometheus exposition format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  test('a registry that fails to collect answers the scrape instead of hanging it', async () => {
    metricsSpy.mockRejectedValueOnce(new Error('collector exploded'));

    const outcome = await Promise.race([
      request(app).get('/metrics').then((r) => ({ responded: true, status: r.status })),
      new Promise((resolve) => setTimeout(() => resolve({ responded: false }), 3000)),
    ]);

    expect(outcome.responded).toBe(true);
    expect(outcome.status).toBeGreaterThanOrEqual(500);
  });
});
