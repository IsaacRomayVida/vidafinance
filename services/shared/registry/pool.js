'use strict';

const { Pool } = require('pg');

let _pool = null;

// Fails closed: a service that requires this module without
// REGISTRY_DATABASE_URL set must not silently run with no registry access.
function getPool() {
  if (_pool) return _pool;

  const connectionString = process.env.REGISTRY_DATABASE_URL;
  if (!connectionString) {
    throw new Error('REGISTRY_DATABASE_URL is not set — registry/ledger access is required, not optional');
  }

  _pool = new Pool({ connectionString });
  return _pool;
}

module.exports = { getPool };
