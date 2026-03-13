const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
require('dotenv').config();

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db    = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});
const app = express();
app.use(helmet());
app.use(express.json({ limit: '100kb' }));

const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── SoftCrédito token cache ─────────────────────────────────────────
let _token = null, _tokenExp = 0;

async function scToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(process.env.SOFTCREDITO_API_URL + '/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.SOFTCREDITO_CLIENT_ID,
      clientSecret: process.env.SOFTCREDITO_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error('SC auth failed: ' + r.status);
  const d = await r.json();
  _token = d.access_token;
  _tokenExp = Date.now() + d.expires_in * 1000;
  return _token;
}

async function scCall(method, path, body) {
  const { default: fetch } = await import('node-fetch');
  const token = await scToken();
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(process.env.SOFTCREDITO_API_URL + path, opts);
  const d = await r.json();
  if (!r.ok) throw new Error('SC API ' + path + ': ' + JSON.stringify(d));
  return d;
}

// ── Health ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: redisOk ? 'ok' : 'degraded', service: 'vida-softcredito-adapter', redis: redisOk, ts: new Date().toISOString() });
});

// ── SPEI disbursement ───────────────────────────────────────────────
app.post('/internal/disburse', requireInternal, async (req, res) => {
  const { loanId, clabe, amount, concept, employeeName, employeeId } = req.body;
  if (!loanId || !clabe || !amount) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await scCall('POST', '/spei/transfer', {
      destinationClabe: clabe,
      amount,
      concept,
      recipientName: employeeName,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId }
    });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── Daily repayment sync ────────────────────────────────────────────
app.post('/internal/sync-repayments', requireInternal, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await scCall('GET', '/deductions/completed?date=' + today);
    let synced = 0;
    const { default: fetch } = await import('node-fetch');
    for (const item of data.deductions || []) {
      const snap = await db.collection('loans')
        .where('softcreditoDeductionId', '==', item.deductionId)
        .limit(1).get();
      if (snap.empty || snap.docs[0].data().status === 'paid') continue;
      const loanId = snap.docs[0].id;
      const loan = snap.docs[0].data();
      await fetch(process.env.PAYMENT_SERVER_URL + '/internal/repayment', {
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
      synced++;
    }
    res.json({ success: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3004, () => console.log('vida-softcredito-adapter on', process.env.PORT || 3004));
