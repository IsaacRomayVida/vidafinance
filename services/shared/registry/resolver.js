'use strict';

const { assertInTransaction } = require('./txGuard');

// Thrown by addExternalRef when a ref already points at a different entity.
// A distinct class (not a plain Error) so HTTP layers can map it to 409
// mechanically instead of pattern-matching err.message.
class RefConflictError extends Error {
  constructor({ system, externalId, existingEntityId, requestedEntityId }) {
    super(
      `entity_refs conflict: ${system}:${externalId} already resolves to ${existingEntityId}, ` +
        `not the requested ${requestedEntityId} -- possible duplicate identity, do not auto-merge`
    );
    this.name = 'RefConflictError';
    this.system = system;
    this.externalId = externalId;
    this.existingEntityId = existingEntityId;
    this.requestedEntityId = requestedEntityId;
  }
}

// Every external ID is a pointer to exactly one entity, never a competing
// copy of it. All functions here must run inside a transaction the caller
// already opened (BEGIN before, COMMIT/ROLLBACK after) -- the advisory lock
// only holds for the transaction's lifetime.

// Normalization lives here, not at call sites -- every caller (registry-
// service's HTTP handlers, and scripts/backfill.js which talks to this
// module directly) must resolve/insert the same normalized value or the
// same real-world identity silently becomes two rows differing only in
// case/formatting. 'phone' is deliberately left as pass-through: E.164
// normalization needs a real phone-number library (country-code inference,
// extensions, etc.) -- a hand-rolled regex here would confidently
// mis-normalize real numbers, which is worse than not normalizing.
function normalizeExternalId(system, externalId) {
  switch (system) {
    case 'rfc':
    case 'curp':
      return externalId.trim().toUpperCase();
    case 'clabe':
      return externalId.replace(/\D/g, '');
    default:
      return externalId;
  }
}

async function lockRef(client, system, externalId, callerName) {
  await assertInTransaction(client, callerName);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${system}:${externalId}`]);
}

async function resolveEntity(client, system, externalId) {
  const normalized = normalizeExternalId(system, externalId);
  const { rows } = await client.query(
    'SELECT entity_id FROM entity_refs WHERE system = $1 AND external_id = $2',
    [system, normalized]
  );
  return rows.length ? rows[0].entity_id : null;
}

// Returns the existing entity for (system, externalId), or creates one.
// Serialized per (system, externalId) so concurrent callers never create
// two entities for the same external identity.
async function resolveOrCreateEntity(client, { system, externalId, kind, displayName, attrs }) {
  const normalized = normalizeExternalId(system, externalId);
  await lockRef(client, system, normalized, 'resolveOrCreateEntity');

  const existingId = await resolveEntity(client, system, normalized);
  if (existingId) return existingId;

  const { rows } = await client.query(
    'INSERT INTO entities (kind, display_name, attrs) VALUES ($1, $2, $3) RETURNING id',
    [kind, displayName ?? null, attrs ?? {}]
  );
  const entityId = rows[0].id;

  await client.query('INSERT INTO entity_refs (system, external_id, entity_id) VALUES ($1, $2, $3)', [
    system,
    normalized,
    entityId,
  ]);

  return entityId;
}

// Attaches an additional external ref to an entity that's already resolved
// (e.g. a worker's RFC alongside their firebase uid). If the ref already
// exists and points at the SAME entity, this is a harmless no-op (the
// common re-run/idempotent case). If it already points at a DIFFERENT
// entity, that is NOT a harmless no-op -- it's the split-identity signal
// (e.g. a worker's CURP already resolved to a different person) and must
// be surfaced loudly, not swallowed, so a caller can decide (log, alert,
// manual review) rather than silently mis-attaching evidence to the wrong
// entity.
async function addExternalRef(client, entityId, system, externalId) {
  const normalized = normalizeExternalId(system, externalId);
  await lockRef(client, system, normalized, 'addExternalRef');

  const { rows } = await client.query(
    `INSERT INTO entity_refs (system, external_id, entity_id) VALUES ($1, $2, $3)
     ON CONFLICT (system, external_id) DO NOTHING
     RETURNING entity_id`,
    [system, normalized, entityId]
  );
  if (rows.length > 0) return;

  const existingEntityId = await resolveEntity(client, system, normalized);
  if (existingEntityId !== entityId) {
    throw new RefConflictError({
      system,
      externalId: normalized,
      existingEntityId,
      requestedEntityId: entityId,
    });
  }
}

module.exports = {
  resolveEntity,
  resolveOrCreateEntity,
  addExternalRef,
  normalizeExternalId,
  RefConflictError,
};
