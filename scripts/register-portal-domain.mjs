/**
 * register-portal-domain.mjs — attach alfa.funtrip.mx to the funpay-alfa
 * Firebase Hosting site via the v1beta1 customDomains API, using the
 * service account in GOOGLE_APPLICATION_CREDENTIALS. Prints the DNS
 * records Cloudflare must hold (ownership TXT + connect records).
 */
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const SITE = 'funpay-alfa';
const DOMAIN = process.env.PORTAL_DOMAIN || 'alfa.funtrip.mx';
const BASE = `https://firebasehosting.googleapis.com/v1beta1/projects/vida-finance/sites/${SITE}`;

const auth = new GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
const client = await auth.getClient();
const { token } = await client.getAccessToken();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
  const updates = domain?.requiredDnsUpdates;
  if (updates?.desired?.length) break;
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
