'use strict';

const { assertInTransaction } = require('./txGuard');

// Every external ID is a pointer to exactly one entity, never a competing
// copy of it. All functions here must run inside a transaction the caller
// already opened (BEGIN before, COMMIT/ROLLBACK after) -- the advisory lock
// only holds for the transaction's lifetime.

async function lockRef(client, system, externalId, callerName) {
  await assertInTransaction(client, callerName);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${system}:${externalId}`]);
}

async function resolveEntity(client, system, externalId) {
  const { rows } = await client.query(
    'SELECT entity_id FROM entity_refs WHERE system = $1 AND external_id = $2',
    [system, externalId]
  );
  return rows.length ? rows[0].entity_id : null;
}

// Returns the existing entity for (system, externalId), or creates one.
// Serialized per (system, externalId) so concurrent callers never create
// two entities for the same external identity.
async function resolveOrCreateEntity(client, { system, externalId, kind, displayName, attrs }) {
  await lockRef(client, system, externalId, 'resolveOrCreateEntity');

  const existingId = await resolveEntity(client, system, externalId);
  if (existingId) return existingId;

  const { rows } = await client.query(
    'INSERT INTO entities (kind, display_name, attrs) VALUES ($1, $2, $3) RETURNING id',
    [kind, displayName ?? null, attrs ?? {}]
  );
  const entityId = rows[0].id;

  await client.query('INSERT INTO entity_refs (system, external_id, entity_id) VALUES ($1, $2, $3)', [
    system,
    externalId,
    entityId,
  ]);

  return entityId;
}

// Attaches an additional external ref to an entity that's already resolved
// (e.g. a worker's RFC alongside their firebase uid). No-op if the ref
// already exists, pointing at whichever entity got there first.
async function addExternalRef(client, entityId, system, externalId) {
  await lockRef(client, system, externalId, 'addExternalRef');
  await client.query(
    `INSERT INTO entity_refs (system, external_id, entity_id) VALUES ($1, $2, $3)
     ON CONFLICT (system, external_id) DO NOTHING`,
    [system, externalId, entityId]
  );
}

module.exports = { resolveEntity, resolveOrCreateEntity, addExternalRef };
