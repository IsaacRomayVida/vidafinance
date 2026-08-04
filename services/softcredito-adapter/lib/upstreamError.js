'use strict';

// One place that turns an upstream (SoftCrédito / bureau / RENAPO) failure
// into something safe to hand back to a caller.
//
// scCall() builds its Error message out of the RAW upstream response body:
//
//     new Error('SC API ' + path + ': ' + JSON.stringify(d))
//
// and the four /internal/* routes answered with
// `res.status(500).json({ error: err.message })`, which put that body verbatim
// into the response. The bodies are the vendor's to shape, and SoftCrédito's
// validation errors echo the fields we sent: the employee's full name and
// destination CLABE on /spei/transfer, the employer RFC and contact email on
// /employers/register, the employee CLABE on /deductions/register.
//
// That string did not stop at the caller. payment-server's disbursement worker
// writes it to loans.disbursementError and incident_log, and passes it to
// alertDisbursementFailed(), which renders it into a Slack/PagerDuty message;
// functions/src/index.ts writes it to loans.disbursementError,
// disbursement_queue.error and the audit log. One upstream validation error
// scattered applicant PII across three Firestore collections and a chat alert.
//
// What is safe to return: the upstream HTTP status, and a short
// machine-readable error code -- but only if it actually looks like a code.
// Free text never is. /bureau/query and /curp/validate already worked this way
// (#527); this brings the /internal/* routes onto the same footing and shares
// the same classifyError() vocabulary.

const { classifyError } = require('./bureauFallback');
const { looksLikeIdentifier } = require('./piiRedact');

// Fields an upstream might carry a machine code in. `error` is deliberately
// absent: in practice it holds free text ("upstream down", "maintenance"), so
// treating it as a code would reopen the leak one field over.
const CODE_FIELDS = ['error_code', 'errorCode', 'code'];

// A code is short, has no whitespace, and starts with a letter. The length cap
// is what stops a sentence -- or a name -- from being waved through as a code.
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Tag an error as having touched the upstream. Everything thrown from inside
 * scCall() qualifies: the !r.ok branch (the body), r.json() (Node's JSON parse
 * error message quotes a slice of the offending input), the transport, and the
 * token fetch (whose failures can quote our credentials).
 */
function markUpstreamFailure(err, path) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.isUpstreamFailure = true;
  if (path && !e.upstreamPath) e.upstreamPath = path;
  return e;
}

/**
 * Pull a machine-readable code out of an upstream body, or null.
 * Rejects anything that does not look like a code, and anything that looks
 * like a national or bank identifier -- an upstream is free to put a CURP in
 * its `code` field, and we are not free to pass it on.
 */
function safeUpstreamCode(body) {
  if (!body || typeof body !== 'object') return null;
  for (const field of CODE_FIELDS) {
    const value = body[field];
    if (typeof value !== 'string') continue;
    if (!CODE_SHAPE.test(value)) continue;
    if (looksLikeIdentifier(value)) continue;
    return value;
  }
  return null;
}

/**
 * Build the response body for a failed request.
 *
 * Upstream failures collapse to a stable shape:
 *   { error: 'upstream_error', reason, code?, upstreamStatus? }
 *
 * Local failures (a Firestore miss, a precondition we check ourselves) keep
 * their own message: those strings are ours, they carry no upstream body, and
 * callers rely on them to tell an operator what to fix.
 */
function toClientError(err) {
  if (!err || !err.isUpstreamFailure) {
    return { error: (err && err.message) || 'internal_error' };
  }
  const payload = { error: 'upstream_error', reason: classifyError(err) };
  const code = safeUpstreamCode(err.upstreamBody);
  if (code) payload.code = code;
  if (err.status) payload.upstreamStatus = err.status;
  return payload;
}

module.exports = { markUpstreamFailure, safeUpstreamCode, toClientError };
