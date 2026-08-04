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

// Thrown by normalizeExternalId when a non-empty raw value normalizes away
// to nothing (e.g. clabe 'N/A' -> '', rfc '   ' -> ''). Deliberately checked
// here, not at HTTP-layer input validation, so every caller -- registry-
// service's routes AND scripts/backfill.js, which calls the resolver
// directly -- is covered by one guard. Without this, two different garbage
// values collapse to the SAME normalized ref (e.g. clabe:''), so the second
// caller silently resolves to whichever entity got there first -- a silent
// identity merge, not a visible failure, and it bypasses RefConflictError
// entirely because from the DB's point of view it's the same ref.
class InvalidExternalIdError extends Error {
  constructor({ system, externalId }) {
    super(
      `invalid externalId for system '${system}': normalizes to the empty string ` +
        `(raw value: ${JSON.stringify(externalId)}) -- refusing to create an ambiguous ref`
    );
    this.name = 'InvalidExternalIdError';
    this.system = system;
    this.externalId = externalId;
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
  let normalized;
  switch (system) {
    case 'rfc':
    case 'curp':
      normalized = externalId.trim().toUpperCase();
      break;
    case 'clabe':
      normalized = externalId.replace(/\D/g, '');
      break;
    default:
      normalized = externalId;
  }
  if (normalized === '') {
    throw new InvalidExternalIdError({ system, externalId });
  }
  return normalized;
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

  // The ref already exists. Whether that is the harmless idempotent case or
  // the split-identity signal turns on one comparison -- and it has to be
  // made by Postgres, not by JS. entityId arrives as whatever the caller
  // spelled it: registry-service takes it straight off the URL as the
  // :entityId path parameter, and scripts/backfill.js passes through
  // whatever it was handed. Postgres stores and returns uuids in exactly one
  // canonical form, so '2898CEFA-...', '2898cefa-...' and the unhyphenated
  // '2898cefa37bc...' are one uuid to the database and three different
  // strings to `!==`. Comparing the raw strings therefore reported a ref
  // that already points at EXACTLY this entity as a conflict -- and not a
  // quiet one, since RefConflictError's message reads "possible duplicate
  // identity, do not auto-merge". An ordinary retry raised the alarm that is
  // supposed to mean two real humans collided, which is how a false alarm
  // ends up costing someone a manual identity review. Casting to uuid here
  // makes the comparison the one that matters: same row, or not.
  const { rows: conflicting } = await client.query(
    `SELECT entity_id FROM entity_refs
     WHERE system = $1 AND external_id = $2 AND entity_id <> $3::uuid`,
    [system, normalized, entityId]
  );
  if (conflicting.length > 0) {
    throw new RefConflictError({
      system,
      externalId: normalized,
      existingEntityId: conflicting[0].entity_id,
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
  InvalidExternalIdError,
};
