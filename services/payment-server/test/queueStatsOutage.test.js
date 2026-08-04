'use strict';

// GET /internal/queue-stats when Redis (i.e. the BullMQ queues it inspects)
// is unreachable.
//
// ── The defect these tests pin ───────────────────────────────────────────────
// miscRoutes.test.js exercises a HEALTHY Redis. These exercise the path where
// a queue's count methods reject.
//
// Express 4 does not catch a rejected promise from an async route handler, so
// the unguarded `await Promise.all([...])` in the per-queue loop sent NO
// response at all when it rejected -- the caller hangs until its own timeout
// instead of getting an error status. Same defect class as the webhook fix in
// #526 and the underwriting/pdf fixes in #528, here on the admin monitoring
// route.
//
// A second, compounding bug rode along: `await q.close()` sat AFTER the
// `await Promise.all(...)`, so on any rejection that iteration's Queue was
// never closed, and the loop never reached the remaining queue names at all --
// their Queue instances were never even constructed. Repeated calls during an
// outage leak Redis connections until the pool is exhausted.
//
// The explicit `.timeout()` below is what makes the hang test discriminating:
// a hang fails it as ECONNABORTED in 2s rather than as an assertion mismatch
// on jest's default timeout.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const { Queue } = require('bullmq');

const SECRET = process.env.INTERNAL_SECRET;
const ALL_QUEUES = ['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting'];

beforeEach(() => {
  Queue.__reset();
});

function getStats() {
  return request(app).get('/internal/queue-stats').set('x-internal-secret', SECRET).timeout(2000);
}

test('does not hang when a queue is unreachable', async () => {
  Queue.__failCounts('vida-disbursements', 'ECONNREFUSED');

  let error = null;
  const res = await getStats().catch((err) => { error = err; return null; });

  // Pre-fix this call throws (supertest's own .timeout() aborts the socket at
  // 2s with ECONNABORTED, since Express never sent a response). Post-fix it
  // resolves. Assert the resolved shape; a caught abort is treated as failure
  // below via the explicit check, not as a silent pass.
  if (error) {
    throw new Error(`request did not resolve -- handler hung (${error.code || error.message})`);
  }
  expect(res.status).not.toBe(undefined);
});

describe('degraded — some queues reachable, some not', () => {
  test('200s with partial stats and reports the unreachable queue in errors', async () => {
    Queue.__failCounts('vida-pdfs', 'ECONNREFUSED');

    const res = await getStats();

    expect(res.status).toBe(200);
    expect(res.body.queues['vida-disbursements']).toEqual({ waiting: 0, active: 0, failed: 0, completed: 0, delayed: 0 });
    expect(res.body.queues['vida-notifications']).toEqual({ waiting: 0, active: 0, failed: 0, completed: 0, delayed: 0 });
    expect(res.body.queues['vida-underwriting']).toEqual({ waiting: 0, active: 0, failed: 0, completed: 0, delayed: 0 });
    expect(res.body.queues['vida-pdfs']).toBeUndefined();
    expect(res.body.errors['vida-pdfs']).toBe('ECONNREFUSED');
  });
});

describe('total outage — every queue unreachable', () => {
  test('503s with a clear error body instead of an empty 200', async () => {
    for (const n of ALL_QUEUES) Queue.__failCounts(n, 'ECONNREFUSED');

    const res = await getStats();

    expect(res.status).toBe(503);
    expect(res.body.error).toBeTruthy();
    for (const n of ALL_QUEUES) expect(res.body.errors[n]).toBe('ECONNREFUSED');
  });
});

describe('cleanup — every Queue instance is closed regardless of outcome', () => {
  test('closes all four queues even when one rejects mid-loop', async () => {
    Queue.__failCounts('vida-notifications', 'ECONNREFUSED');

    await getStats();

    // Pre-fix, close() sat after the awaited Promise.all -- a rejection meant
    // that iteration's queue was never closed AND the loop never even reached
    // the remaining names. Every one of the four must be closed regardless.
    expect(Queue.closedNames.sort()).toEqual([...ALL_QUEUES].sort());
  });

  test('closes all four queues on a total outage', async () => {
    for (const n of ALL_QUEUES) Queue.__failCounts(n, 'ECONNREFUSED');

    await getStats();

    expect(Queue.closedNames.sort()).toEqual([...ALL_QUEUES].sort());
  });
});

// ── Controls ────────────────────────────────────────────────────────────────
// These pass in BOTH the before and after states. They are what makes the red
// tests above evidence of a real defect rather than of a broken harness: the
// healthy path is untouched by the fix.
describe('controls — unchanged by the fix', () => {
  test('200s with full stats for all four queues when Redis is healthy', async () => {
    const res = await getStats();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.queues).sort()).toEqual([...ALL_QUEUES].sort());
    expect(res.body.queues['vida-disbursements']).toEqual({ waiting: 0, active: 0, failed: 0, completed: 0, delayed: 0 });
    expect(res.body.errors).toBeUndefined();
  });

  test('closes all four queues on the healthy path', async () => {
    await getStats();
    expect(Queue.closedNames.sort()).toEqual([...ALL_QUEUES].sort());
  });

  test('still 401s with no internal secret', async () => {
    const res = await request(app).get('/internal/queue-stats');
    expect(res.status).toBe(401);
  });
});
