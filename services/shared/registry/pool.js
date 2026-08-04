'use strict';

const { Pool } = require('pg');

let _pool = null;

// node-postgres' defaults are wrong for this service in three separate ways,
// so every bound below is set explicitly rather than inherited.
//
// The important one is connectionTimeoutMillis. Its default is 0, which does
// not mean "no timeout applies", it means WAIT FOREVER: on an exhausted pool
// pool.connect() never settles. registry-service's withTransaction has an
// explicit 503 branch commented "the pool is exhausted or the database is
// unreachable" -- with the default, the exhaustion half of that branch is
// unreachable and the request simply hangs. That is defect #524 ("a database
// outage hung every write instead of failing") one layer down, with the same
// symptom: the caller waits out its own timeout, and alert5xx never fires
// because alert5xx is wired to res.json and no response is ever sent. So an
// outage reads as latency, not failure.
const POOL_MAX = Number(process.env.REGISTRY_POOL_MAX || 10);
const CONNECTION_TIMEOUT_MS = Number(process.env.REGISTRY_CONNECTION_TIMEOUT_MS || 5000);
const IDLE_TIMEOUT_MS = Number(process.env.REGISTRY_IDLE_TIMEOUT_MS || 30000);

// resolver.js serializes concurrent writers for one identity with
// pg_advisory_xact_lock, and that wait is unbounded server-side. One wedged
// lock holder would otherwise block every later resolve for the same identity
// forever -- and each blocked request holds a pool slot while it waits, so
// contention on one identity drains the pool for all the others. Generous
// enough that no healthy resolve is anywhere near it; the point is that a
// stuck one dies instead of accumulating.
const STATEMENT_TIMEOUT_MS = Number(process.env.REGISTRY_STATEMENT_TIMEOUT_MS || 15000);

// withTransaction issues BEGIN and then awaits application code. If that code
// stalls (a hung HTTP call, an event-loop block), the server holds the
// transaction's row locks and advisory lock indefinitely. This bounds it from
// the server side, where a stalled Node process cannot interfere.
const IDLE_IN_TX_TIMEOUT_MS = Number(process.env.REGISTRY_IDLE_IN_TX_TIMEOUT_MS || 20000);

// Fails closed: a service that requires this module without
// REGISTRY_DATABASE_URL set must not silently run with no registry access.
function getPool() {
  if (_pool) return _pool;

  const connectionString = process.env.REGISTRY_DATABASE_URL;
  if (!connectionString) {
    throw new Error('REGISTRY_DATABASE_URL is not set — registry/ledger access is required, not optional');
  }

  _pool = new Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
  });

  // Pool is an EventEmitter, and it emits 'error' when the backend behind an
  // IDLE pooled client goes away -- a Postgres restart, a failover, an
  // idle-session reaper, an operator's pg_terminate_backend. With no 'error'
  // listener that is an unhandled 'error' event, which does not degrade the
  // pool: Node throws it, and it takes the whole service process down. The
  // pool already discards the dead client by itself and the next acquire gets
  // a fresh one, so there is nothing to recover here -- the only thing
  // missing was somewhere for the notification to land. Logged rather than
  // rethrown precisely because a routine database restart must not be a
  // service outage.
  _pool.on('error', (err) => {
    console.error(`[registry pool] idle client error (client discarded, pool still usable): ${err.message}`);
  });

  return _pool;
}

module.exports = { getPool };
