'use strict';

// PII scrubbing for this service's log stream.
//
// Wired in as pino's `formatters.log` in index.js, so it is the single choke
// point every logged object passes through on its way out. There was no
// existing `redact` config to extend, and pino's `redact` would not have been
// enough on its own: it matches statically declared paths, and the objects we
// most need scrubbed are upstream response bodies whose shape SoftCrédito
// chooses, not us. So the scrub walks the object instead.
//
// Two rules, applied together:
//
//   1. Values under a PII-named key are HASHED, not deleted. An operator
//      reading the logs can still see that a field was present, and can still
//      tell "this is the same CURP as the failure ten minutes ago", without
//      being able to read the CURP itself.
//   2. Identifier-shaped substrings (CURP, RFC, CLABE, email) are scrubbed out
//      of free text under ANY key, because vendors put the offending value in
//      the human-readable `message` as often as in a dedicated field.
//
// What this deliberately does NOT do: recover a person's name from prose. No
// pattern matcher can. That is precisely why the HTTP-response side of this
// fix withholds upstream free text entirely rather than trying to clean it --
// see lib/upstreamError.js. A name embedded in an upstream `message` can still
// reach the server-side log; the log is a trusted sink, a response body handed
// to a caller that persists and Slack-alerts it is not.

const crypto = require('crypto');

// Optional salt. Without it the hashes are still far better than plaintext,
// but a CURP is derived from name + date of birth + state, so its space is
// enumerable for a targeted individual and an unsalted digest is reversible by
// brute force. Set LOG_HASH_SALT to a stable per-environment secret to close
// that; keeping it stable (rather than random per process) is what preserves
// cross-restart correlation.
const SALT = () => process.env.LOG_HASH_SALT || '';

function hashForLog(value) {
  return 'sha256:' + crypto.createHash('sha256').update(SALT() + String(value)).digest('hex').slice(0, 12);
}

// Key fragments that mark a value as PII. Matched against the key lowercased
// with non-alphanumerics stripped, so `full_name`, `fullName` and `FullName`
// all collapse to `fullname`.
//
// Kept deliberately tight. A broader list (`account`, `id`, `ref`) would hash
// the operational fields -- loanId, employeeId, upstreamStatus -- that make a
// log line diagnosable at all, and a log nobody can read is not a control.
const PII_KEY_FRAGMENTS = [
  'curp',
  'rfc',
  'clabe',
  'name',      // fullName, recipientName, employeeName, companyName, expectedName
  'nombre',
  'email',
  'correo',
  'phone',
  'telefono',
  'celular',
  'birth',     // dateOfBirth
  'nacimiento',
  'address',
  'direccion',
];

function isPiiKey(key) {
  const normalised = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return PII_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

// Identifier shapes, scrubbed out of any string value.
// Order matters: email first (its local part can look like an RFC), then the
// fixed-width national identifiers, then bare long digit runs.
const PATTERNS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  // CURP: 4 letters, 6 digits (YYMMDD), H|M, 5 letters, 2 alphanumerics.
  [/\b[A-ZÑ]{4}\d{6}[HM][A-ZÑ]{5}[A-Z0-9]{2}\b/gi, '[curp]'],
  // RFC: 3-4 letters, 6 digits, 3-character homoclave.
  [/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/gi, '[rfc]'],
  // CLABE is 18 digits; card PANs are 16-19. Anything in that range is an
  // account number, not a quantity worth logging in the clear.
  [/\b\d{16,19}\b/g, '[account]'],
];

function scrubText(value) {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Bounds. Log formatting runs on every line, and an upstream body is
// attacker-influenced input: neither depth nor breadth may be unbounded.
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

function walk(value, depth, seen) {
  if (value == null) return value;

  if (typeof value === 'string') {
    return scrubText(value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…[truncated]' : value);
  }
  if (typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[depth-limited]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`[+${value.length - MAX_ARRAY} more]`);
    return items;
  }

  // Errors serialise to {} through a plain key walk; keep the useful parts.
  if (value instanceof Error) {
    return { message: scrubText(String(value.message)), code: value.code, status: value.status };
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isPiiKey(key)) {
      // Objects and arrays under a PII key (e.g. `name: { first, last }`) are
      // hashed whole rather than walked -- the key already told us the whole
      // subtree is sensitive.
      out[key] = child == null ? child : hashForLog(typeof child === 'object' ? JSON.stringify(child) : child);
    } else {
      out[key] = walk(child, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Scrub PII out of a log object. Returns a new object; the input is untouched,
 * which matters because pino hands us the caller's object, not a copy.
 */
function redactPii(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  return walk(obj, 0, new WeakSet());
}

/**
 * True if a string looks like a national/bank identifier. Used by
 * lib/upstreamError.js to refuse to pass an upstream "error code" through to a
 * caller when the upstream has stuffed a CURP into it.
 */
function looksLikeIdentifier(value) {
  if (typeof value !== 'string') return false;
  return PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0; // these are /g, so reset before .test
    return pattern.test(value);
  });
}

module.exports = { redactPii, hashForLog, looksLikeIdentifier, isPiiKey };
