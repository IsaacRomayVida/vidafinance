'use strict';

// BUREAU_MODE fallback for SoftCredito bureau outages (VID3-653).
//
// Four modes:
//   live         — default; call the bureau; propagate errors.
//   optimistic   — on failure, synthesize a "clean" bureau response so
//                  underwriting can proceed with a manual-review flag.
//   pessimistic  — on failure, synthesize a "high-risk" bureau response
//                  that forces decline / manual review.
//   offline      — NEVER call the bureau; always synthesize a neutral
//                  response (useful for local dev / staged envs).
//
// Synthesized responses carry a top-level `_fallback` marker so
// downstream services (underwriting, audit logs) can tell that the data
// is not real.

const client = require('prom-client');
const { register: sharedRegister } = require('../../shared/metrics');

const VALID_MODES = Object.freeze(['live', 'optimistic', 'pessimistic', 'offline']);

function parseBureauMode(raw) {
  const v = (raw == null || raw === '') ? 'live' : String(raw).trim().toLowerCase();
  if (!VALID_MODES.includes(v)) {
    throw new Error(
      `Invalid BUREAU_MODE="${raw}". Must be one of: ${VALID_MODES.join(', ')}`,
    );
  }
  return v;
}

// Register once. If the module is reloaded (e.g. jest resetModules), reuse
// any pre-existing metric to avoid the "already registered" error.
function getOrCreateCounter() {
  const existing = sharedRegister.getSingleMetric('softcredito_bureau_fallback_total');
  if (existing) return existing;
  return new client.Counter({
    name: 'softcredito_bureau_fallback_total',
    help: 'Count of SoftCredito bureau fallback invocations, by mode and reason',
    labelNames: ['mode', 'reason'],
    registers: [sharedRegister],
  });
}

const fallbackCounter = getOrCreateCounter();

// Shape matches what the legacy /bureau/query error branch already returns to
// upstream callers (see index.js): { hasBureauRecord, score, activeDefaults,
// competitorLoans, ... }. We extend it with a _fallback marker.
function synthesizeBureauResponse(mode, reason) {
  const base = { _fallback: { mode, reason, timestamp: new Date().toISOString() } };
  if (mode === 'optimistic') {
    return {
      ...base,
      hasBureauRecord: false,
      score: 750,
      activeDefaults: 0,
      competitorLoans: 0,
      manualReviewRequired: true,
    };
  }
  if (mode === 'pessimistic') {
    return {
      ...base,
      hasBureauRecord: true,
      score: 350,
      activeDefaults: 5,
      competitorLoans: 3,
      manualReviewRequired: true,
    };
  }
  // offline (neutral)
  return {
    ...base,
    hasBureauRecord: false,
    score: 500,
    activeDefaults: 0,
    competitorLoans: 0,
    manualReviewRequired: true,
  };
}

// Classify a thrown error into a short reason string used as a metric label
// and as the _fallback.reason field.
function classifyError(err) {
  if (!err) return 'unknown_error';
  const code = err.code || '';
  const msg = String(err.message || '');
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return 'network_error';
  }
  if (/timeout/i.test(msg) || code === 'ETIMEDOUT') return 'timeout';
  if (/\bSC API\b/.test(msg) || /\berror_code\b/.test(msg) || /\b4\d{2}\b|\b5\d{2}\b/.test(msg)) {
    return 'upstream_error_code';
  }
  return 'network_error';
}

// Wrap a live bureau call with mode-aware fallback. `liveFn` is an async
// function that performs the real call and returns the bureau response (or
// throws on failure). `log` is optional and only used for warn logs.
//
// In `live` mode this is a pass-through. In `optimistic` / `pessimistic`,
// any thrown error from liveFn is caught and a synthesized response is
// returned instead. In `offline`, liveFn is never invoked.
async function withBureauFallback({ mode, liveFn, log }) {
  if (mode === 'offline') {
    fallbackCounter.inc({ mode: 'offline', reason: 'disabled_by_config' });
    return synthesizeBureauResponse('offline', 'disabled_by_config');
  }

  if (mode === 'live') {
    return liveFn();
  }

  try {
    return await liveFn();
  } catch (err) {
    const reason = classifyError(err);
    fallbackCounter.inc({ mode, reason });
    if (log && typeof log.warn === 'function') {
      // NOT err.message. scCall() builds that from the raw upstream body, and
      // a bureau validation error quotes the CURP and full name it was queried
      // with -- so this line wrote a national ID and a name into the log
      // stream in clear on every optimistic/pessimistic fallback.
      //
      // Deliberately not "log the body and let the formatter scrub it": this
      // module is handed whatever `log` its caller passes, so it cannot assume
      // a redacting logger. Status + classified reason is the same detail the
      // already-fixed /bureau/query and /curp/validate handlers log, and is
      // what the fallback metric is labelled by.
      log.warn(
        { mode, reason, upstreamStatus: err && err.status },
        'SoftCredito bureau call failed — returning synthesized fallback',
      );
    }
    return synthesizeBureauResponse(mode, reason);
  }
}

module.exports = {
  VALID_MODES,
  parseBureauMode,
  synthesizeBureauResponse,
  classifyError,
  withBureauFallback,
  fallbackCounter,
};
