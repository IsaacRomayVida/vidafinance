'use strict';

// Every test here exercises the pool's FAILURE modes, not its happy path.
// The happy path is already covered transitively by resolver.test.js and
// registry-service/index.test.js -- what was untested, and what this file
// exists for, is what the pool does when Postgres goes away or runs out of
// slots. That is the state the registry's alerting and 503 handling exist
// for, and all of it was running on node-postgres' defaults.

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vida_registry_test';

describe('getPool', () => {
  let pool;

  beforeEach(() => {
    jest.resetModules();
    process.env.REGISTRY_DATABASE_URL = DATABASE_URL;
    delete process.env.REGISTRY_POOL_MAX;
    delete process.env.REGISTRY_STATEMENT_TIMEOUT_MS;
    pool = null;
  });

  afterEach(async () => {
    if (pool) await pool.end().catch(() => {});
  });

  test('throws instead of returning a pool when REGISTRY_DATABASE_URL is unset', () => {
    delete process.env.REGISTRY_DATABASE_URL;
    const { getPool } = require('./pool');
    expect(() => getPool()).toThrow(/REGISTRY_DATABASE_URL is not set/);
  });

  // registry-service's withTransaction has an explicit 503 branch for
  // "the pool is exhausted or the database is unreachable". node-postgres
  // defaults connectionTimeoutMillis to 0, which means WAIT FOREVER, so on
  // pool exhaustion pool.connect() never settles and that branch is dead
  // code. index.test.js only ever proved the branch works by mocking
  // pool.connect() to reject -- it never proved the pool itself rejects.
  // That is defect #524 ("a database outage hung every write instead of
  // failing") one layer down: the caller hangs, and because alert5xx is
  // wired to res.json, nothing fires.
  test('rejects an acquire on an exhausted pool instead of waiting forever', async () => {
    process.env.REGISTRY_POOL_MAX = '1';
    const { getPool } = require('./pool');
    pool = getPool();

    const held = await pool.connect(); // occupy the only slot
    try {
      const started = Date.now();
      // The race is the discriminating part: an unbounded wait fails this as
      // a 'still-pending' timeout rather than as an assertion mismatch.
      const outcome = await Promise.race([
        pool.connect().then(
          (c) => {
            c.release();
            return 'acquired';
          },
          (err) => `rejected: ${err.message}`
        ),
        new Promise((r) => setTimeout(() => r('still-pending'), 8000)),
      ]);
      expect(outcome).toMatch(/^rejected:/);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      held.release();
    }
  }, 20000);

  // node-postgres' Pool is an EventEmitter and emits 'error' when the
  // backend behind an IDLE pooled client goes away -- a Postgres restart,
  // a failover, an idle-session reaper, an operator's pg_terminate_backend.
  // With no 'error' listener that emit is an unhandled 'error' event, which
  // does not degrade the pool: it throws and takes the whole service process
  // down. The pool discards the dead client on its own; the only thing
  // missing was somewhere for the notification to land.
  test('an idle-client error is handled, not thrown as an unhandled error event', () => {
    const { getPool } = require('./pool');
    pool = getPool();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
  });

  test('survives the backend behind an idle pooled client being terminated', async () => {
    const { getPool } = require('./pool');
    pool = getPool();

    const client = await pool.connect();
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
    client.release(); // client is now idle IN the pool, not checked out

    const { Pool } = require('pg');
    const killer = new Pool({ connectionString: DATABASE_URL });
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
      await new Promise((r) => setTimeout(r, 500));
      // Reaching here at all means no unhandled 'error' event fired, and the
      // pool must still be usable afterwards -- a discarded dead client is
      // not supposed to be a service outage.
      const after = await pool.query('SELECT 1 AS ok');
      expect(after.rows[0].ok).toBe(1);
    } finally {
      await killer.end();
    }
  }, 20000);

  // resolver.js serializes writers with pg_advisory_xact_lock. That wait is
  // unbounded server-side, so one wedged lock holder blocks every later
  // resolve for the same identity forever -- each blocked request holding a
  // pool slot the whole time, which then exhausts the pool for identities
  // that were never contended. statement_timeout is what bounds that.
  test('applies a server-side statement timeout so a blocked query cannot hold a slot forever', async () => {
    // Overridden down from the 15s default purely so this test takes ~1s
    // rather than ~15s; what is under test is that the value reaches the
    // server and is enforced, not the specific number.
    process.env.REGISTRY_STATEMENT_TIMEOUT_MS = '1000';
    const { getPool } = require('./pool');
    pool = getPool();

    const shown = await pool.query('SHOW statement_timeout');
    expect(shown.rows[0].statement_timeout).not.toBe('0');

    await expect(pool.query('SELECT pg_sleep(3)')).rejects.toMatchObject({
      code: '57014', // query_canceled
    });
  }, 30000);

  test('bounds an idle-in-transaction session so a stalled handler cannot hold locks forever', async () => {
    const { getPool } = require('./pool');
    pool = getPool();
    const shown = await pool.query('SHOW idle_in_transaction_session_timeout');
    expect(shown.rows[0].idle_in_transaction_session_timeout).not.toBe('0');
  });
});
