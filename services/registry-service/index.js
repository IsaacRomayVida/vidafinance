const express = require('express');
const helmet = require('helmet');
require('dotenv').config();

const { alert5xx } = require('../shared/alerting');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
const { getPool } = require('../shared/registry/pool');
const {
  resolveOrCreateEntity,
  addExternalRef,
  RefConflictError,
  InvalidExternalIdError,
} = require('../shared/registry/resolver');

// Fail closed: this service exists only to talk to the registry DB and gate
// on INTERNAL_SECRET. Missing either at boot means it cannot do its job.
if (!process.env.REGISTRY_DATABASE_URL) {
  throw new Error('REGISTRY_DATABASE_URL is required to start vida-registry-service');
}
if (!process.env.INTERNAL_SECRET) {
  throw new Error('INTERNAL_SECRET is required to start vida-registry-service');
}

const SERVICE_NAME = 'vida-registry-service';
const pool = getPool();

const app = express();
app.use(helmet());
app.use(metricsMiddleware(SERVICE_NAME));
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500) alert5xx(SERVICE_NAME, res.statusCode, req.path);
    return origJson(body);
  };
  next();
});

const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// normalizeExternalId (resolver.js) calls externalId.trim() -- a caller
// sending a JSON number/object for system or externalId must 400 here,
// not TypeError into a generic 500 three layers down.
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

// Shared by both routes below: a RefConflictError means the request is
// well-formed but collides with an existing, different identity -- that's
// a 409 (client can act on entity ids in the body), never a 500.
function sendRegistryError(res, err, genericMessage) {
  if (err instanceof RefConflictError) {
    return res.status(409).json({
      error: 'ref_conflict',
      system: err.system,
      externalId: err.externalId,
      existingEntityId: err.existingEntityId,
      requestedEntityId: err.requestedEntityId,
    });
  }
  if (err instanceof InvalidExternalIdError) {
    return res.status(400).json({
      error: 'invalid_external_id',
      system: err.system,
      externalId: err.externalId,
    });
  }
  return res.status(500).json({ error: genericMessage, message: err.message });
}

// Both write routes below own a transaction, and three things in that shape
// can fail -- but only one of them used to be handled. Acquiring the
// connection ran outside the try, and the ROLLBACK issued while handling a
// failure can itself throw on a connection that has already died. Express 4
// does not catch a rejected promise from an async route handler, so either of
// those sent NO response at all: the caller hung until its own timeout (the
// Cloud Functions callers here run an 8s one), and alert5xx never fired,
// because alert5xx is wired to res.json. That made a database outage -- the
// exact condition this service's alerting exists for -- look like latency
// rather than failure. withTransaction makes all three paths end in a
// response.
async function withTransaction(res, genericMessage, work) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    // The pool is exhausted or the database is unreachable. Neither is the
    // caller's fault and both are retryable, so 503 rather than 500.
    return res.status(503).json({ error: 'registry_unavailable', message: err.message });
  }
  try {
    await client.query('BEGIN');
    const body = await work(client);
    await client.query('COMMIT');
    return res.json(body);
  } catch (err) {
    // Deliberately swallow a failing ROLLBACK. If the socket is dead the
    // server aborts the transaction on its own, and the original error is
    // the one worth reporting -- letting the secondary error replace it
    // would report "Connection terminated" for every genuine 409 or 400
    // that happened to race a disconnect.
    await client.query('ROLLBACK').catch(() => {});
    return sendRegistryError(res, err, genericMessage);
  } finally {
    // Must run on every path, including the failure ones: an outage that
    // leaks one client per request drains the pool and then never recovers.
    client.release();
  }
}

// This service has no browser-facing routes -- every route below is called
// server-to-server (Cloud Functions, other Railway services), same pattern
// as underwriting-service's /riskseal/smoke and softcredito-adapter's
// /internal/* routes.

app.get('/health', async (req, res) => {
  const ok = await pool
    .query('SELECT 1')
    .then(() => true)
    .catch(() => false);
  res.json({ status: ok ? 'ok' : 'degraded', service: SERVICE_NAME, db: ok, ts: new Date().toISOString() });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

// POST /internal/entities/resolve
// body: { system, externalId, kind, displayName?, attrs?, refs?: [{system, externalId}] }
// Resolves the entity behind (system, externalId), creating it if this is
// the first time this external identity has been seen. Idempotent.
//
// `refs` optionally attaches additional external refs (e.g. a worker's RFC
// alongside their firebase uid) in the SAME transaction as the resolve --
// one request, one round trip, one commit, instead of a resolve call
// followed by N separate /refs calls each paying their own network + tx
// overhead (that pattern was costing approveEmployer up to ~16s in the
// worst case with two 8s-timeout sequential calls).
app.post('/internal/entities/resolve', requireInternal, async (req, res) => {
  const { system, externalId, kind, displayName, attrs, refs } = req.body ?? {};
  if (!isNonEmptyString(system) || !isNonEmptyString(externalId) || !kind) {
    return res.status(400).json({ error: 'system, externalId, and kind are required' });
  }
  if (
    refs !== undefined &&
    (!Array.isArray(refs) ||
      refs.some((r) => !r || !isNonEmptyString(r.system) || !isNonEmptyString(r.externalId)))
  ) {
    return res.status(400).json({ error: 'refs must be an array of {system, externalId} strings' });
  }

  return withTransaction(res, 'resolve failed', async (client) => {
    const entityId = await resolveOrCreateEntity(client, { system, externalId, kind, displayName, attrs });
    for (const ref of refs ?? []) {
      await addExternalRef(client, entityId, ref.system, ref.externalId);
    }
    return { entityId };
  });
});

// POST /internal/entities/:entityId/refs
// body: { system, externalId }
// Attaches an additional external ref to an already-resolved entity
// (e.g. a worker's RFC alongside their firebase uid).
app.post('/internal/entities/:entityId/refs', requireInternal, async (req, res) => {
  const { entityId } = req.params;
  const { system, externalId } = req.body ?? {};
  if (!isNonEmptyString(system) || !isNonEmptyString(externalId)) {
    return res.status(400).json({ error: 'system and externalId are required' });
  }

  return withTransaction(res, 'add ref failed', async (client) => {
    await addExternalRef(client, entityId, system, externalId);
    return { ok: true };
  });
});

const PORT = process.env.PORT || 3006;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on ${PORT}`);
  });
}

module.exports = { app, pool };
