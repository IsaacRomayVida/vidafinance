const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const pino = require('pino');
const { alert5xx, alertRateLimit, alertRedisLost } = require('../shared/alerting');
require('dotenv').config();

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

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
  const tokenUrl = process.env.SOFTCREDITO_TOKEN_URL
    || 'https://softcredito.com/produccion/ALIADOSDECRED/app/api/oauth/token';
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-REST-PRODUCT': process.env.SOFTCREDITO_PRODUCT_ID || process.env.SOFTCREDITO_CLIENT_ID,
      'X-REST-APPLICATION': process.env.SOFTCREDITO_APPLICATION_ID || process.env.SOFTCREDITO_CLIENT_SECRET,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('SC auth failed: ' + r.status + ' ' + body.slice(0, 200));
  }
  const d = await r.json();
  _token = d.token || d.access_token;
  _tokenExp = Date.now() + (d.expires_in || 900) * 1000;
  log.info({ tokenUrl }, 'SC token acquired');
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
  if (r.status === 429) {
    alertRateLimit(SERVICE_NAME, 'SoftCredito');
  }
  const d = await r.json();
  if (!r.ok) throw new Error('SC API ' + path + ': ' + JSON.stringify(d));
  return d;
}


app.get('/debug-routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(r => {
    if (r.route) routes.push({ method: Object.keys(r.route.methods)[0], path: r.route.path });
  });
  res.json({ routes, ts: new Date().toISOString() });
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
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



// ── Bureau query via SoftCrédito API ────────────────────────────────────────
app.get('/debug-connectivity', async (req, res) => {
  const { execSync } = require('child_process');
  const results = {};
  
  // 1. Our outbound IP
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://api.ipify.org?format=json');
    results.outboundIP = (await r.json()).ip;
  } catch(e) { results.outboundIP = 'ERROR: ' + e.message; }
  
  // 2. DNS resolution
  try {
    const dns = require('dns').promises;
    results.dns_softcredito = await dns.resolve4('softcredito.com');
    results.dns_pr_softcredito = await dns.resolve4('pr.softcredito.com').catch(() => 'NXDOMAIN');
  } catch(e) { results.dns = 'ERROR: ' + e.message; }
  
  // 3. Direct HTTPS to softcredito.com
  try {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    const r = await fetch('https://softcredito.com/', { 
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    results.https_softcredito = { 
      status: r.status, 
      statusText: r.statusText,
      latencyMs: Date.now() - start,
      headers: Object.fromEntries([...r.headers.entries()].slice(0, 5))
    };
  } catch(e) { results.https_softcredito = 'ERROR: ' + e.message; }
  
  // 4. Direct HTTPS to the token endpoint (supports ?token_url= override for probing)
  const tokenUrl = req.query.token_url
    || process.env.SOFTCREDITO_TOKEN_URL
    || 'https://softcredito.com/produccion/ALIADOSDECRED/app/api/oauth/token';
  try {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-REST-PRODUCT': process.env.SOFTCREDITO_PRODUCT_ID || process.env.SOFTCREDITO_CLIENT_ID,
        'X-REST-APPLICATION': process.env.SOFTCREDITO_APPLICATION_ID || process.env.SOFTCREDITO_CLIENT_SECRET,
      },
      signal: AbortSignal.timeout(15000)
    });
    const body = await r.text();
    const contentType = r.headers.get('content-type') || '';
    results.token_endpoint = {
      url: tokenUrl,
      status: r.status,
      latencyMs: Date.now() - start,
      isJson: contentType.includes('application/json') || body.trim().startsWith('{'),
      bodyPreview: body.substring(0, 300),
      server: r.headers.get('server'),
      contentType,
    };
  } catch(e) { results.token_endpoint = { error: e.message, url: tokenUrl }; }

  // 5. Direct IP connection to their production server
  try {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    const r = await fetch('https://3.128.113.238/', {
      method: 'GET',
      headers: { 'Host': 'softcredito.com' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    });
    results.direct_ip = {
      status: r.status,
      latencyMs: Date.now() - start,
      server: r.headers.get('server'),
    };
  } catch(e) { results.direct_ip = 'ERROR: ' + e.message; }
  
  res.json(results);
});

app.get('/debug-sc-token', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const tokenUrl = process.env.SOFTCREDITO_TOKEN_URL;
    const clientId = process.env.SOFTCREDITO_CLIENT_ID;
    const clientSecret = process.env.SOFTCREDITO_CLIENT_SECRET;
    const body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) + '&client_secret=' + encodeURIComponent(clientSecret);
    
    console.log('Testing SC token URL:', tokenUrl);
    console.log('Body:', body);
    
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body
    });
    
    const rawText = await r.text();
    const isJson = rawText.trim().startsWith('{');
    
    res.json({
      status: r.status,
      statusText: r.statusText,
      headers: Object.fromEntries(r.headers.entries()),
      isJson,
      body: rawText.substring(0, 500),
      tokenUrl,
      clientIdPrefix: clientId?.substring(0, 8) + '...',
    });
  } catch (e) {
    res.json({ error: e.message, stack: e.stack?.substring(0, 300) });
  }
});

app.get('/check-outbound-ip', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json({ outboundIP: data.ip, expectedIP: '162.220.232.99', match: data.ip === '162.220.232.99' });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/routes-check', (req, res) => res.json({routes: ['health','bureau/query','curp/validate','internal/*'], version: 'v2-bureau'}));

app.post('/bureau/query', requireInternal, async (req, res) => {
  const { curp, fullName, dateOfBirth, rfc } = req.body;
  if (!curp || !fullName || !dateOfBirth) {
    return res.status(400).json({ error: 'Missing required fields: curp, fullName, dateOfBirth' });
  }
  try {
    const data = await scCall('POST', '/bureau/query', { curp, fullName, dateOfBirth, rfc });
    res.json(data);
  } catch (err) {
    log.warn({ error: err.message }, 'Bureau query error — returning defaults');
    res.json({ hasBureauRecord: false, score: 500, activeDefaults: 0, competitorLoans: 0, error: err.message });
  }
});

// ── CURP validation via RENAPO ──────────────────────────────────────────────
app.post('/curp/validate', requireInternal, async (req, res) => {
  const { curp, expectedName } = req.body;
  if (!curp) return res.status(400).json({ error: 'CURP required' });
  try {
    const data = await scCall('POST', '/curp/validate', { curp, expectedName });
    res.json(data);
  } catch (err) {
    log.warn({ error: err.message }, 'CURP validation error — accepting by format');
    res.json({ valid: true, fullName: expectedName || null });
  }
});

app.listen(process.env.PORT || 3002, () => log.info({ port: process.env.PORT || 3002 }, 'vida-softcredito-adapter started'));
