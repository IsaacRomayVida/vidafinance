/**
 * register-portal-domain.mjs — attach alfa.funtrip.mx to the funpay-alfa
 * Firebase Hosting site (v1beta1 customDomains API). Zero dependencies:
 * the service-account access token is minted with node:crypto (RS256 JWT
 * → oauth2 token exchange). Prints the DNS records Cloudflare must hold.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const SITE = 'funpay-alfa';
const DOMAIN = process.env.PORTAL_DOMAIN || 'alfa.funtrip.mx';
const BASE = `https://firebasehosting.googleapis.com/v1beta1/projects/vida-finance/sites/${SITE}`;

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned =
  b64({ alg: 'RS256', typ: 'JWT' }) +
  '.' +
  b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
const jwt = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
});
const { access_token } = await tokenRes.json();
if (!access_token) {
  console.error('token exchange failed', await tokenRes.text?.());
  process.exit(1);
}
const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

async function get() {
  const r = await fetch(`${BASE}/customDomains/${DOMAIN}`, { headers });
  return r.ok ? r.json() : null;
}

let domain = await get();
if (!domain) {
  const create = await fetch(`${BASE}/customDomains?customDomainId=${DOMAIN}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!create.ok) {
    console.error('create failed', create.status, await create.text());
    process.exit(1);
  }
  console.log('customDomain created, waiting for DNS requirements…');
}

for (let i = 0; i < 30; i++) {
  domain = await get();
  if (domain?.requiredDnsUpdates?.desired?.length) break;
  await new Promise((r) => setTimeout(r, 4000));
}

console.log('HOST_STATE:', domain?.hostState, 'CERT_STATE:', domain?.certState);
const wanted = [];
for (const set of domain?.requiredDnsUpdates?.desired ?? []) {
  for (const rec of set.records ?? []) {
    wanted.push({ name: rec.domainName, type: rec.type, value: rec.rdata });
  }
}
console.log('REQUIRED_DNS=' + JSON.stringify(wanted));
