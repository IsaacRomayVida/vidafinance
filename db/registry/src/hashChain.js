'use strict';

const crypto = require('crypto');
const { assertInTransaction } = require('./txGuard');

// Fixed 32-byte zero buffer used as prev_hash for the first receipt ever
// written. Documented here rather than derived so any independent verifier
// can reproduce it without access to this code. receipts_prev_hash_unique
// (migration 0001) also means at most one row in the whole table can ever
// hold this value, so it doubles as the single-genesis constraint.
const GENESIS_HASH = Buffer.alloc(32, 0);

// The hash algorithm/canonicalization rules a receipt was written under.
// New rules get a new version and a new entry here; existing rows keep
// verifying under whatever version they were written with -- history is
// never rewritten to match a newer contract.
const CURRENT_HASH_VERSION = 1;

// v1 canonicalization contract (pinned -- do not change without bumping
// CURRENT_HASH_VERSION and adding a v2 entry to HASH_VERSIONS):
//   - allowed: null, boolean, string, integer number, Buffer, plain object, array
//   - rejected: undefined, NaN/Infinity, non-integer number, Date, any object
//     with a custom toJSON()
// Rationale: node-pg serializes jsonb through JSON.stringify semantics that
// silently coerce or drop exactly these cases (undefined keys vanish, Date
// becomes an ISO string, NaN/Infinity become null) -- if the hash is computed
// over the pre-serialization JS value, a later recompute from the
// stored/reloaded jsonb diverges from what was actually persisted and
// verifyChain reports corruption that never happened. Rejecting them up
// front means the hashed value and the stored value are always the same
// bytes. Non-integer numbers are rejected specifically so money amounts are
// forced into an unambiguous representation (integer cents, or a string) --
// floats are a well-known source of representation drift across languages/
// libraries and have no place in an audit-facing evidence payload.
function assertHashable(value, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (Buffer.isBuffer(value)) return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path}: non-finite number (NaN/Infinity) cannot be hashed`);
    }
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `${path}: non-integer number ${value} cannot be hashed -- money amounts must be ` +
          `integer cents (number or string), not floats`
      );
    }
    return;
  }

  if (value === undefined) {
    throw new TypeError(`${path}: undefined cannot be hashed -- omit the key or use null`);
  }

  if (value instanceof Date) {
    throw new TypeError(`${path}: Date cannot be hashed directly -- pass an ISO string instead`);
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertHashable(v, `${path}[${i}]`));
    return;
  }

  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      throw new TypeError(
        `${path}: object with a custom toJSON() cannot be hashed -- it would serialize ` +
          `differently than this walk sees it; convert it to a plain value explicitly first`
      );
    }
    for (const key of Object.keys(value)) {
      assertHashable(value[key], `${path}.${key}`);
    }
    return;
  }

  throw new TypeError(`${path}: unsupported type ${typeof value} cannot be hashed`);
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
}

function canonicalJson(value) {
  assertHashable(value, 'row');
  return JSON.stringify(canonicalize(value));
}

function computeHashV1(prevHash, row) {
  return crypto.createHash('sha256').update(prevHash).update(canonicalJson(row)).digest();
}

const HASH_VERSIONS = { 1: computeHashV1 };

function computeHash(prevHash, row, hashVersion = CURRENT_HASH_VERSION) {
  const fn = HASH_VERSIONS[hashVersion];
  if (!fn) throw new Error(`unknown hash_version ${hashVersion}`);
  return fn(prevHash, row);
}

// ts is included so the *when* of a receipt is tamper-evident, not just its
// content -- it is read from clock_timestamp() by the caller (appendReceipt)
// rather than left to the column DEFAULT, so the exact value that goes into
// the hash is the exact value that gets stored. node-pg hands back
// timestamptz columns as JS Date objects (both from the clock_timestamp()
// SELECT in appendReceipt and from the ts column in verifyChain's SELECT) --
// normalized to the same ISO-string representation here, which is also the
// literal value appendReceipt inserts (not the original clock_timestamp()
// SQL value), so both sides of the chain always hash identical bytes for
// identical instants. Trade-off: JS Date is millisecond-precision, so
// receipts.ts stores millisecond precision, not clock_timestamp()'s
// microseconds -- an accepted loss in exchange for hash/storage being
// provably the same value.
function receiptRow(receipt) {
  return {
    ts: receipt.ts instanceof Date ? receipt.ts.toISOString() : receipt.ts,
    actor_entity_id: receipt.actorEntityId,
    action: receipt.action,
    target_entity_id: receipt.targetEntityId ?? null,
    relationship_id: receipt.relationshipId ?? null,
    evidence: receipt.evidence ?? {},
    idempotency_key: receipt.idempotencyKey ?? null,
  };
}

// Appends exactly one receipt. Must be called with a client that is inside
// an open transaction (BEGIN already issued by the caller) so the advisory
// lock and the insert commit together. Serializes concurrent writers on a
// single fixed key so the chain stays gap-free: no two receipts can ever
// compute their hash from the same prev_hash. receipts_prev_hash_unique
// (migration 0001) is the backstop that turns any failure of that
// serialization into a loud INSERT error instead of a silent fork.
async function appendReceipt(client, receipt) {
  await assertInTransaction(client, 'appendReceipt');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('vida_receipts_chain'))");

  const { rows: prevRows } = await client.query('SELECT hash FROM receipts ORDER BY seq DESC LIMIT 1');
  const prevHash = prevRows.length ? prevRows[0].hash : GENESIS_HASH;

  const { rows: tsRows } = await client.query('SELECT clock_timestamp() AS ts');
  const ts = tsRows[0].ts;

  const row = receiptRow({ ...receipt, ts });
  const hash = computeHash(prevHash, row, CURRENT_HASH_VERSION);

  const inserted = await client.query(
    `INSERT INTO receipts
       (ts, actor_entity_id, action, target_entity_id, relationship_id, evidence, idempotency_key, hash_version, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING seq, id, ts, hash`,
    [
      row.ts,
      row.actor_entity_id,
      row.action,
      row.target_entity_id,
      row.relationship_id,
      row.evidence,
      row.idempotency_key,
      CURRENT_HASH_VERSION,
      prevHash,
      hash,
    ]
  );

  return inserted.rows[0];
}

// Recomputes the chain from the first receipt and verifies every stored
// hash matches. Catches corruption regardless of how it happened -- a bug
// in appendReceipt, a direct INSERT by an operator, storage bit rot.
// Loads the whole table into memory -- fine at Phase A volume; switch to a
// cursor/keyset pagination before the ledger is large.
async function verifyChain(client) {
  const { rows } = await client.query(
    `SELECT seq, ts, actor_entity_id, action, target_entity_id, relationship_id,
            evidence, idempotency_key, hash_version, prev_hash, hash
     FROM receipts ORDER BY seq ASC`
  );

  let expectedPrev = GENESIS_HASH;
  for (const r of rows) {
    if (!expectedPrev.equals(r.prev_hash)) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'prev_hash mismatch' };
    }

    if (!HASH_VERSIONS[r.hash_version]) {
      return { ok: false, brokenAtSeq: r.seq, reason: `unknown hash_version ${r.hash_version}` };
    }

    let recomputed;
    try {
      recomputed = computeHash(
        expectedPrev,
        receiptRow({
          ts: r.ts,
          actorEntityId: r.actor_entity_id,
          action: r.action,
          targetEntityId: r.target_entity_id,
          relationshipId: r.relationship_id,
          evidence: r.evidence,
          idempotencyKey: r.idempotency_key,
        }),
        r.hash_version
      );
    } catch (err) {
      return { ok: false, brokenAtSeq: r.seq, reason: `unhashable stored row: ${err.message}` };
    }

    if (!recomputed.equals(r.hash)) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'hash mismatch' };
    }
    expectedPrev = r.hash;
  }
  return { ok: true };
}

module.exports = {
  GENESIS_HASH,
  CURRENT_HASH_VERSION,
  canonicalJson,
  computeHash,
  appendReceipt,
  verifyChain,
};
