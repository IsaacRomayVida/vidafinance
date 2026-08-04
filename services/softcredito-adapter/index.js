const { assertInternalSecret, requireInternal } = require('./lib/internalAuth');
require('dotenv').config();

// Fail closed, before anything else loads: requireInternal compares the request
// header against process.env.INTERNAL_SECRET. If the variable is unset both
// sides are `undefined`, the comparison passes, and every internal route
// (disburse, register-employer, register-deduction, sync-repayments,
// bureau/query, curp/validate) becomes publicly callable with no header at all.
// Refuse to boot rather than serve disbursements unauthenticated.
// Same pattern as vida-underwriting-service.
assertInternalSecret();

const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const pino = require('pino');
const { alert5xx, alertRateLimit, alertRedisLost, alertDisbursementFailed } = require('../shared/alerting');
const { scTokenRaw } = require('./lib/scToken');
const { getFetch } = require('./lib/fetchClient');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
const { parseBureauMode, withBureauFallback, classifyError } = require('./lib/bureauFallback');
const { redactPii } = require('./lib/piiRedact');
const { markUpstreamFailure, toClientError } = require('./lib/upstreamError');
const {
  claimDisbursement,
  markClaimSent,
  releaseClaim,
  isDefiniteUpstreamRejection,
} = require('./lib/disbursementClaim');

// `formatters.log` runs on every merged log object, which makes it the one
// choke point PII has to pass through on its way into the log stream. There
// was no `redact` config here to extend, and pino's `redact` would not have
// covered this anyway: it matches statically declared paths, and the objects
// most in need of scrubbing are upstream response bodies whose shape
// SoftCrédito chooses. See lib/piiRedact.js.
const log = pino({
  name: 'vida-softcredito-adapter',
  level: process.env.LOG_LEVEL || 'info',
  formatters: { level: (label) => ({ level: label }), log: redactPii },
});

// Fail-fast on invalid BUREAU_MODE. Default is 'live' (no behavior change).
const BUREAU_MODE = parseBureauMode(process.env.BUREAU_MODE);
log.info({ bureauMode: BUREAU_MODE }, 'bureau mode configured');

const svcAcct = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
const db    = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});
const SERVICE_NAME = 'vida-softcredito-adapter';
redis.on('error', (err) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('ECONNRESET')) {
    alertRedisLost(SERVICE_NAME);
  }
});

const ALLOWED = ['https://vida-finance.web.app'];
const app = express();
app.use(helmet());
app.use(metricsMiddleware('vida-softcredito-adapter'));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret'); return res.sendStatus(204); }
  next();
});
app.use(express.json({ limit: '100kb' }));

// 5xx alert interceptor
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500) alert5xx(SERVICE_NAME, res.statusCode, req.path);
    return origJson(body);
  };
  next();
});

// ── SoftCrédito token cache ─────────────────────────────────────────
let _token = null, _tokenExp = 0;

async function scToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const d = await scTokenRaw();
  _token = d.token || d.access_token;
  _tokenExp = Date.now() + (d.expires_in || 900) * 1000;
  log.info({ tokenUrl: process.env.SOFTCREDITO_TOKEN_URL }, 'SC token acquired');
  return _token;
}

// Outbound timeout for the READ-ONLY SoftCrédito calls. node-fetch v3 has no
// default timeout of its own, so without an abort signal an upstream that
// accepts the connection and then never answers holds the request -- and the
// underwriting request queued behind it -- open forever. 15s matches the
// timeout lib/scToken.js already applies to this service's other outbound
// call.
//
// Opt-in per call site, and deliberately NOT applied to /spei/transfer,
// /employers/register or /deductions/register: aborting a request that may
// already have moved money turns one hung call into an ambiguous one.
//
// /internal/disburse is no longer *unsafe* to retry -- lib/disbursementClaim.js
// now claims the loan's disbursement before dispatch, and an aborted transfer
// leaves that claim 'in_flight' so every retry refuses rather than re-sends.
// But refusing is a manual reconciliation, so a timeout here still converts
// "slow" into "needs a human", which is why one is not being added on the way
// past. Whether the money-moving calls should time out remains a question for
// whoever owns the SoftCrédito integration contract.
const SC_READ_TIMEOUT_MS = () => Number(process.env.SC_HTTP_TIMEOUT_MS) || 15000;

async function scCall(method, path, body, callOpts = {}) {
  try {
    const fetch = await getFetch();
    const token = await scToken();
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);
    if (callOpts.timeoutMs) opts.signal = AbortSignal.timeout(callOpts.timeoutMs);
    const r = await fetch(process.env.SOFTCREDITO_API_URL + path, opts);
    if (r.status === 429) {
      alertRateLimit(SERVICE_NAME, 'SoftCredito');
    }
    const d = await r.json();
    if (!r.ok) {
      // The status is carried on the error object so failure paths can log which
      // upstream status we got without logging the response body, which for the
      // bureau and CURP endpoints echoes the queried subject's CURP and name.
      //
      // The parsed body rides along on `upstreamBody` rather than only inside
      // the message string, so lib/upstreamError.js can lift a machine-readable
      // code out of it without anyone having to re-parse free text.
      const err = new Error('SC API ' + path + ': ' + JSON.stringify(d));
      err.status = r.status;
      err.upstreamBody = d;
      throw err;
    }
    return d;
  } catch (err) {
    // Everything thrown from inside this function has touched the upstream and
    // is therefore unsafe to echo to a caller: the !r.ok branch carries the
    // response body; r.json() throws a JSON parse error whose message quotes a
    // slice of the offending input; the transport and the token fetch can
    // quote a URL or our own credentials. Tagging here -- rather than at each
    // call site -- is what makes "did this text come from outside?" a property
    // of the error itself. See lib/upstreamError.js.
    throw markUpstreamFailure(err, path);
  }
}

// Answer a failed /internal/* request without handing the caller anything the
// upstream wrote. The full detail goes to the operator instead, through the
// logger above, whose formatter hashes PII-named fields and scrubs
// identifier-shaped substrings -- redacted, not dropped.
//
// Status codes are unchanged (500): payment-server and functions/src/index.ts
// both branch on `!resp.ok` and nothing finer.
function respondUpstreamFailure(res, err, route) {
  const payload = toClientError(err);
  log.error(
    {
      route,
      reason: payload.reason || 'local_error',
      upstreamStatus: err && err.status,
      upstreamCode: payload.code,
      // For an upstream failure the parsed body IS the detail, and it survives
      // the log formatter in structured form. For a local error there is no
      // body, so the message is the only detail there is.
      upstreamBody: err && err.upstreamBody,
      detail: err && err.isUpstreamFailure && err.upstreamBody ? undefined : err && err.message,
    },
    'request failed',
  );
  res.status(500).json(payload);
}


// ── Health ──────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  // Express 4 does not catch a rejected promise from an async route handler:
  // an unguarded `await` here left the scrape with no response at all, hanging
  // the caller until it timed out. Same shape as registry-service (#524) and
  // payment-server (#526).
  try {
    const body = await metricsRegister.metrics();
    res.set('Content-Type', metricsRegister.contentType);
    res.end(body);
  } catch (err) {
    log.warn({ error: err.message }, 'metrics collection failed');
    res.status(500).json({ error: 'metrics_unavailable' });
  }
});

app.get('/health', async (req, res) => {
  // v2 - with bureau+curp routes
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: redisOk ? 'ok' : 'degraded', service: 'vida-softcredito-adapter', redis: redisOk, ts: new Date().toISOString() });
});

// ── SPEI disbursement ───────────────────────────────────────────────
app.post('/internal/disburse', requireInternal, async (req, res) => {
  const { loanId, clabe, amount, concept, employeeName, employeeId } = req.body;
  if (!loanId || !clabe || !amount) return res.status(400).json({ error: 'Missing fields' });

  // Claim this LOAN's disbursement before anything reaches SoftCrédito. SPEI
  // has no idempotency key, so this transaction is the only thing standing
  // between a retried job and a second real payout. See lib/disbursementClaim.js
  // for why the claim is keyed on loanId rather than a caller-supplied key, and
  // why in-flight and confirmed-sent are answered differently.
  //
  // Wrapped because this await sits outside the try below and express 4 has no
  // async error handling: an unhandled rejection here would leave the request
  // with no response at all, so the caller hangs until its own timeout rather
  // than seeing a failure. Nothing has been dispatched at this point -- a
  // transaction that throws never committed -- so the retry this 503 invites is
  // safe, and the borrower is not left unfunded by a transient Firestore blip.
  let claim;
  try {
    claim = await claimDisbursement({ db, admin, loanId, amount, clabe });
  } catch (err) {
    log.error({ loanId, error: err.message }, 'disburse aborted — could not claim disbursement, nothing dispatched');
    return res.status(503).json({
      error: 'disbursement_claim_unavailable',
      reason: 'could_not_establish_idempotency_claim',
      loanId,
    });
  }

  if (claim.outcome === 'already_sent') {
    // 200, not 4xx. The caller is payment-server's disburseWorker
    // (services/payment-server/index.js:410), which treats any non-2xx as a job
    // failure and retries to exhaustion before marking the loan
    // disbursement_error and paging ops. Erroring on a replay would page ops
    // about a borrower who was in fact paid, correctly, once. Hand back the
    // original receipt and let the job complete.
    log.info({ loanId, ref: claim.ref }, 'disburse replay — already sent, no transfer dispatched');
    return res.json({ success: true, ref: claim.ref, transferId: claim.transferId, idempotentReplay: true });
  }

  if (claim.outcome === 'indeterminate') {
    // A previous attempt dispatched and never came back with an answer. We do
    // not know whether the money left. Re-sending on a guess pays the borrower
    // twice; refusing costs one reconciliation ticket against SoftCrédito.
    // Refuse, loudly.
    log.error({ loanId, amount, claimedAt: claim.claimedAt }, 'disburse refused — previous attempt unconfirmed, needs manual reconciliation');
    alertDisbursementFailed(SERVICE_NAME, loanId, 'previous disbursement attempt unconfirmed — reconcile with SoftCrédito before retrying');
    return res.status(409).json({
      error: 'disbursement_indeterminate',
      reason: 'previous_attempt_unconfirmed',
      loanId,
    });
  }

  if (claim.outcome === 'conflict') {
    // Same loanId, different amount or destination CLABE. Not a replay: a
    // second, different payout against a loan that has already been funded.
    log.error({ loanId, amount }, 'disburse refused — loan already disbursed with different terms');
    alertDisbursementFailed(SERVICE_NAME, loanId, 'second disbursement requested with different amount/CLABE');
    return res.status(409).json({
      error: 'disbursement_conflict',
      reason: 'loan_already_disbursed_with_different_terms',
      loanId,
    });
  }

  try {
    const r = await scCall('POST', '/spei/transfer', {
      destinationClabe: clabe,
      amount,
      concept,
      recipientName: employeeName,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId }
    });

    // Settle the claim FIRST, ahead of the bookkeeping below. Any of those
    // writes can fail -- .update() on a disbursement_queue doc that was never
    // created throws NOT_FOUND -- and a confirmed transfer left reading
    // 'in_flight' would strand a correctly funded loan behind a manual
    // reconciliation.
    await markClaimSent({ db, admin, loanId, ref: r.trackingCode || r.reference, transferId: r.transferId });

    await db.collection('loans').doc(loanId).update({
      status: 'active',
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      disbursementRef: r.trackingCode || r.reference,
      softcreditoTransferId: r.transferId
    });
    await db.collection('disbursement_queue').doc(loanId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      speiRef: r.trackingCode
    });
    await db.collection('spei_log').add({
      loanId, employeeId, amount, clabe, concept,
      speiRef: r.trackingCode,
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'sent'
    });
    res.json({ success: true, ref: r.trackingCode, transferId: r.transferId });
  } catch (err) {
    // The claim is released ONLY when SoftCrédito answered with a complete 4xx
    // response -- it refused the request on its face, before any money could
    // move, so a retry is safe and the borrower can still be funded. Timeouts,
    // aborts, unparseable bodies, 5xx (a vendor that paid the borrower and then
    // fell over writing its own ledger still answers 500) and anything else we
    // cannot positively classify leave the claim 'in_flight', which makes every
    // subsequent retry refuse. That asymmetry is deliberate: the cost of
    // wrongly refusing is a support ticket, the cost of wrongly retrying is a
    // duplicate payout.
    if (isDefiniteUpstreamRejection(err)) {
      await releaseClaim({ db, admin, loanId, reason: 'upstream_rejected_' + err.status })
        .catch((relErr) => log.error({ loanId, error: relErr.message }, 'failed to release disbursement claim'));
    } else {
      log.error({ loanId }, 'disburse outcome unknown — claim left in_flight, retries will refuse until reconciled');
    }
    respondUpstreamFailure(res, err, '/internal/disburse');
  }
});

// ── Register employer with SoftCrédito ─────────────────────────────
app.post('/internal/register-employer', requireInternal, async (req, res) => {
  const { employerUid, companyName, rfc, clabe, contactEmail } = req.body;
  try {
    const r = await scCall('POST', '/employers/register', {
      name: companyName,
      rfc,
      payrollClabe: clabe,
      contactEmail,
      metadata: { firebaseUid: employerUid }
    });
    await db.collection('employers').doc(employerUid).update({
      softcreditoEmployerId: r.employerId,
      softcreditoRegisteredAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('softcredito_employers').doc(employerUid).set({
      employerId: r.employerId,
      companyName, rfc, clabe,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active'
    });
    res.json({ success: true, employerId: r.employerId });
  } catch (err) {
    respondUpstreamFailure(res, err, '/internal/register-employer');
  }
});

// ── Register payroll deduction for a loan ──────────────────────────
app.post('/internal/register-deduction', requireInternal, async (req, res) => {
  const { loanId, employeeId, employerId, amount, dueDate } = req.body;
  try {
    const emp = (await db.collection('employers').doc(employerId).get()).data();
    if (!emp.softcreditoEmployerId) throw new Error('Employer not registered with SoftCrédito');
    const employee = (await db.collection('employees').doc(employeeId).get()).data();
    const r = await scCall('POST', '/deductions/register', {
      softcreditoEmployerId: emp.softcreditoEmployerId,
      employeeClabe: employee.bankClabe,
      amount,
      deductionDate: dueDate,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId }
    });
    await db.collection('loans').doc(loanId).update({ softcreditoDeductionId: r.deductionId });
    res.json({ success: true, deductionId: r.deductionId });
  } catch (err) {
    respondUpstreamFailure(res, err, '/internal/register-deduction');
  }
});

// ── Daily repayment sync ────────────────────────────────────────────
app.post('/internal/sync-repayments', requireInternal, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await scCall('GET', '/deductions/completed?date=' + today);
    let synced = 0;
    const failed = [];
    const fetch = await getFetch();
    for (const item of data.deductions || []) {
      const snap = await db.collection('loans')
        .where('softcreditoDeductionId', '==', item.deductionId)
        .limit(1).get();
      if (snap.empty || snap.docs[0].data().status === 'paid') continue;
      const loanId = snap.docs[0].id;
      const loan = snap.docs[0].data();

      // THE FORWARD'S ANSWER IS THE ONLY EVIDENCE THE MONEY WAS BOOKED.
      //
      // This was a bare `await fetch(...)` with no `resp.ok` branch, followed
      // unconditionally by `synced++`. payment-server answers 400 on an
      // unusable deduction reference, 404 when the loan is not found and 500
      // when the settlement transaction throws -- and every one of those was
      // counted as a synced repayment and rolled into `{ success: true }`.
      //
      // The deduction has already been taken out of the borrower's paycheck by
      // this point; the forward is what turns it into a balance reduction. A
      // dropped forward is never retried either, because the next run queries
      // `/deductions/completed?date=` for ITS date -- today's deductions are
      // never asked for again. The repayment is simply lost.
      //
      // And a 200 here is load-bearing beyond this service:
      // functions/src/scheduled/dailyLoanCheck.ts:34-53 gates the overdue sweep
      // on this route's status precisely so it never takes an adverse action on
      // stale knowledge of what payroll collected. Reporting success on a batch
      // we failed to book defeats that gate, and the borrower who did pay is
      // marked overdue, dunned over the notification queue and counted in
      // arrears.
      //
      // A throw is caught per item rather than left to abort the loop: one
      // unreachable moment must not strand the rest of the batch, which would
      // be the same silent loss one deduction wider.
      let resp;
      try {
        resp = await fetch(process.env.PAYMENT_SERVER_URL + '/internal/repayment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
          body: JSON.stringify({
            loanId,
            employeeId: loan.employeeId,
            amount: item.amount,
            ref: item.reference,
            method: 'payroll_deduction'
          })
        });
      } catch (fwdErr) {
        log.error({ loanId, error: fwdErr.message }, 'repayment forward failed — deduction collected but not booked');
        failed.push({ loanId, status: null });
        continue;
      }

      if (!resp.ok) {
        log.error({ loanId, status: resp.status }, 'repayment forward rejected — deduction collected but not booked');
        failed.push({ loanId, status: resp.status });
        continue;
      }
      synced++;
    }

    // Non-2xx when anything failed to book. Deliberately not a partial success:
    // the caller's only question is "do I now know what payroll collected?",
    // and with even one deduction unbooked the answer is no. `synced` still
    // rides along so a human can see how much of the batch did land, and the
    // successful forwards stay applied -- they are idempotent on
    // `repayments/payroll_<ref>`, so the retry that follows re-applies nothing.
    //
    // No explicit alert call: the 5xx interceptor above fires alert5xx on any
    // response this route sends with a >= 500 status, and the only alert helper
    // that fits the shape is alertDisbursementFailed, which would page with
    // "Disbursement failed for loan X" -- the wrong incident entirely, and the
    // wrong runbook, for a repayment that failed to book.
    if (failed.length > 0) {
      log.error(
        { failed: failed.length, synced, loanIds: failed.map((f) => f.loanId) },
        'repayment sync incomplete — deductions collected but not booked',
      );
      return res.status(502).json({
        error: 'repayment_forward_failed',
        reason: 'deductions_collected_but_not_booked',
        synced,
        failed: failed.length,
      });
    }

    res.json({ success: true, synced });
  } catch (err) {
    respondUpstreamFailure(res, err, '/internal/sync-repayments');
  }
});



// ── Bureau query via SoftCrédito API ────────────────────────────────────────
app.post('/bureau/query', requireInternal, async (req, res) => {
  const { curp, fullName, dateOfBirth, rfc } = req.body;
  if (!curp || !fullName || !dateOfBirth) {
    return res.status(400).json({ error: 'Missing required fields: curp, fullName, dateOfBirth' });
  }
  try {
    const data = await withBureauFallback({
      mode: BUREAU_MODE,
      log,
      liveFn: () => scCall('POST', '/bureau/query', { curp, fullName, dateOfBirth, rfc }, { timeoutMs: SC_READ_TIMEOUT_MS() }),
    });
    res.json(data);
  } catch (err) {
    // Only reached in 'live' mode, where errors propagate through.
    //
    // Fail closed. This used to answer 200 with
    // { hasBureauRecord: false, score: 500, activeDefaults: 0, competitorLoans: 0 },
    // which is a claim about the applicant we have no basis for: we never
    // reached the bureau. The caller
    // (underwriting-service/src/stages/stage2-bureau.js) decides a read
    // failed on `!res.ok` and nothing else -- it does not read this `error`
    // field, and the record flag it reads from a 2xx body is
    // `has_bureau_record`, which this route has never emitted, so it falls
    // through to `?? true`. A 200 here was therefore taken downstream as a
    // real bureau record, with a mid-range score, an explicit "no active
    // defaults" and an explicit "no competitor loans" -- an outage rendered
    // as a clean file. A non-2xx routes it into that caller's existing
    // failure branch, which marks the bureau block `skipped`.
    //
    // No score is returned, and the upstream body is not echoed: bureau
    // validation errors quote the CURP and full name they were queried with.
    const reason = classifyError(err);
    log.warn({ reason, upstreamStatus: err.status }, 'Bureau query failed — no bureau data returned');
    res.status(502).json({ error: 'bureau_unavailable', reason });
  }
});

// ── CURP validation via RENAPO ──────────────────────────────────────────────
app.post('/curp/validate', requireInternal, async (req, res) => {
  const { curp, expectedName } = req.body;
  if (!curp) return res.status(400).json({ error: 'CURP required' });
  try {
    const data = await scCall('POST', '/curp/validate', { curp, expectedName }, { timeoutMs: SC_READ_TIMEOUT_MS() });
    res.json(data);
  } catch (err) {
    // Fail closed. This used to answer 200 with { valid: true, fullName:
    // expectedName } on any failure -- reporting an identity check that never
    // ran as a successful one, and echoing the applicant's own claimed name
    // back in `fullName`, a field whose meaning is "the name RENAPO holds for
    // this CURP".
    //
    // The accept-by-format fallback the old comment described lives in the
    // caller, functions/src/index.ts's validateCURP, which already applies it
    // on a non-2xx response ("CURP adapter error, accepting by format"). So
    // this does not change the loan outcome; it stops this service asserting a
    // validation it did not perform.
    const reason = classifyError(err);
    log.warn({ reason, upstreamStatus: err.status }, 'CURP validation failed — no RENAPO answer returned');
    res.status(502).json({ error: 'curp_validation_unavailable', reason });
  }
});

if (require.main === module) {
  app.listen(process.env.PORT || 3002, () => log.info({ port: process.env.PORT || 3002 }, 'vida-softcredito-adapter started'));
}

module.exports = { app };
