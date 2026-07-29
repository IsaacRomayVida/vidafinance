'use strict';

const crypto = require('crypto');

// Fixed 32-byte zero buffer used as prev_hash for the first receipt ever
// written. Documented here rather than derived so any independent verifier
// can reproduce it without access to this code.
const GENESIS_HASH = Buffer.alloc(32, 0);

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
  return JSON.stringify(canonicalize(value));
}

function computeHash(prevHash, row) {
  return crypto.createHash('sha256').update(prevHash).update(canonicalJson(row)).digest();
}

function receiptRow(receipt) {
  return {
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
// compute their hash from the same prev_hash.
async function appendReceipt(client, receipt) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('vida_receipts_chain'))");

  const { rows } = await client.query('SELECT hash FROM receipts ORDER BY seq DESC LIMIT 1');
  const prevHash = rows.length ? rows[0].hash : GENESIS_HASH;

  const row = receiptRow(receipt);
  const hash = computeHash(prevHash, row);

  const inserted = await client.query(
    `INSERT INTO receipts
       (actor_entity_id, action, target_entity_id, relationship_id, evidence, idempotency_key, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING seq, id, ts, hash`,
    [
      row.actor_entity_id,
      row.action,
      row.target_entity_id,
      row.relationship_id,
      row.evidence,
      row.idempotency_key,
      prevHash,
      hash,
    ]
  );

  return inserted.rows[0];
}

// Recomputes the chain from the first receipt and verifies every stored
// hash matches. Catches corruption regardless of how it happened -- a bug
// in appendReceipt, a direct INSERT by an operator, storage bit rot.
async function verifyChain(client) {
  const { rows } = await client.query(
    `SELECT seq, actor_entity_id, action, target_entity_id, relationship_id,
            evidence, idempotency_key, prev_hash, hash
     FROM receipts ORDER BY seq ASC`
  );

  let expectedPrev = GENESIS_HASH;
  for (const r of rows) {
    if (!expectedPrev.equals(r.prev_hash)) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'prev_hash mismatch' };
    }
    const recomputed = computeHash(expectedPrev, receiptRow({
      actorEntityId: r.actor_entity_id,
      action: r.action,
      targetEntityId: r.target_entity_id,
      relationshipId: r.relationship_id,
      evidence: r.evidence,
      idempotencyKey: r.idempotency_key,
    }));
    if (!recomputed.equals(r.hash)) {
      return { ok: false, brokenAtSeq: r.seq, reason: 'hash mismatch' };
    }
    expectedPrev = r.hash;
  }
  return { ok: true };
}

module.exports = { GENESIS_HASH, canonicalJson, computeHash, appendReceipt, verifyChain };
