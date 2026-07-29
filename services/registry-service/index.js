const express = require('express');
const helmet = require('helmet');
require('dotenv').config();

const { alert5xx } = require('../shared/alerting');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
const { getPool } = require('../shared/registry/pool');
const { resolveOrCreateEntity, addExternalRef } = require('../shared/registry/resolver');

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
// body: { system, externalId, kind, displayName?, attrs? }
// Resolves the entity behind (system, externalId), creating it if this is
// the first time this external identity has been seen. Idempotent.
app.post('/internal/entities/resolve', requireInternal, async (req, res) => {
  const { system, externalId, kind, displayName, attrs } = req.body ?? {};
  if (!system || !externalId || !kind) {
    return res.status(400).json({ error: 'system, externalId, and kind are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entityId = await resolveOrCreateEntity(client, { system, externalId, kind, displayName, attrs });
    await client.query('COMMIT');
    res.json({ entityId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'resolve failed', message: err.message });
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
  if (!system || !externalId) {
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
    res.status(500).json({ error: 'add ref failed', message: err.message });
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
