const https = require('https');
const { URL } = require('url');

const API_BASE = process.env.METAMAP_API_BASE_URL || 'https://api.metamap.com';
const CLIENT_ID = process.env.METAMAP_CLIENT_ID || '';
const CLIENT_SECRET = process.env.METAMAP_CLIENT_SECRET || '';

let _cachedToken = null;
let _tokenExpiresAt = 0;

function httpsRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'POST',
      headers: opts.headers || {},
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('MetaMap request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('MetaMap credentials not configured');
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const { status, body } = await httpsRequest(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }, 'grant_type=client_credentials');
  if (status < 200 || status >= 300) {
    throw new Error(`MetaMap token fetch failed: ${status} ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body);
  _cachedToken = parsed.access_token;
  _tokenExpiresAt = Date.now() + (parsed.expires_in || 3600) * 1000;
  return _cachedToken;
}

async function createSignedDocument({ loanId, metamapVerificationId, pdfBase64, signerEmail, signerName }) {
  if (!metamapVerificationId) {
    throw new Error('metamapVerificationId required to create signed document');
  }
  const token = await getAccessToken();
  const payload = JSON.stringify({
    externalId: loanId,
    identityId: metamapVerificationId,
    document: { filename: `contrato_${loanId}.pdf`, contentBase64: pdfBase64 },
    signer: { email: signerEmail, fullName: signerName },
    metadata: { loanId, source: 'vida-finance' },
  });
  const { status, body } = await httpsRequest(`${API_BASE}/v2/signed-documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);
  if (status < 200 || status >= 300) {
    throw new Error(`MetaMap signing request failed: ${status} ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body);
  return {
    documentId: parsed.id || parsed.documentId,
    status: parsed.status || 'pending',
  };
}

function isEnabled() {
  return process.env.METAMAP_SIGNING_ENABLED === 'true';
}

module.exports = {
  createSignedDocument,
  isEnabled,
  _resetTokenCache: () => { _cachedToken = null; _tokenExpiresAt = 0; },
};
