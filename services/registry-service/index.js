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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entityId = await resolveOrCreateEntity(client, { system, externalId, kind, displayName, attrs });
    for (const ref of refs ?? []) {
      await addExternalRef(client, entityId, ref.system, ref.externalId);
    }
    await client.query('COMMIT');
    res.json({ entityId });
  } catch (err) {
    await client.query('ROLLBACK');
    sendRegistryError(res, err, 'resolve failed');
  } finally {
    client.release();
  }
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await addExternalRef(client, entityId, system, externalId);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    sendRegistryError(res, err, 'add ref failed');
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3006;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on ${PORT}`);
  });
}

module.exports = { app, pool };
