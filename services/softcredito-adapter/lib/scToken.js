const https = require('https');
const { URL } = require('url');

// Native https.request() to preserve exact header casing (e.g. X-REST-PRODUCT).
// node-fetch lowercases header names on the wire, which SoftCredito's Apache
// auth module rejects at the vhost routing layer with a 404. See VID3-702/703.
function scTokenRawFromUrl(tokenUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenUrl) return reject(new Error('SOFTCREDITO_TOKEN_URL not set'));
    let u;
    try {
      u = new URL(tokenUrl);
    } catch (e) {
      return reject(new Error('SOFTCREDITO_TOKEN_URL invalid: ' + e.message));
    }
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-REST-PRODUCT': opts.product,
        'X-REST-APPLICATION': opts.application,
        'Content-Length': '0',
      },
      timeout: opts.timeout || 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('SC auth failed: ' + res.statusCode + ' ' + body.slice(0, 300)));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('SC auth non-JSON response: ' + body.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('SC auth timeout')); });
    req.end();
  });
}

function scTokenRaw() {
  return scTokenRawFromUrl(process.env.SOFTCREDITO_TOKEN_URL, {
    product: process.env.SOFTCREDITO_PRODUCT_ID || process.env.SOFTCREDITO_CLIENT_ID,
    application: process.env.SOFTCREDITO_APPLICATION_ID || process.env.SOFTCREDITO_CLIENT_SECRET,
  });
}

module.exports = { scTokenRaw, scTokenRawFromUrl };
