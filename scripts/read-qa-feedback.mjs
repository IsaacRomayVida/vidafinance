/**
 * read-qa-feedback.mjs — print recent `qa_feedback` reports.
 *
 * Reads are admin-only by security rule, so this runs with the production
 * service account and talks to the Firestore REST API directly. Token
 * minting is the same node:crypto RS256 → oauth2 exchange as
 * register-portal-domain.mjs, for the same reason: nothing to install.
 *
 * Env: GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path)
 *      FEEDBACK_LIMIT (default 25)
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const PROJECT = process.env.PORTAL_PROJECT || 'vida-finance';
const LIMIT = Number(process.env.FEEDBACK_LIMIT || 25);
const DB = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned =
  b64({ alg: 'RS256', typ: 'JWT' }) +
  '.' +
  b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
const jwt = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body:
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' +
    encodeURIComponent(jwt),
});
const tokenJson = await tokenRes.json().catch(() => ({}));
if (!tokenJson.access_token) {
  console.error('token exchange failed', tokenRes.status, JSON.stringify(tokenJson));
  process.exit(1);
}

const res = await fetch(`${DB}:runQuery`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokenJson.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'qa_feedback' }],
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: LIMIT,
    },
  }),
});
if (!res.ok) {
  console.error('query failed', res.status, await res.text());
  process.exit(1);
}

const rows = (await res.json())
  .filter((r) => r.document)
  .map((r) => {
    const f = r.document.fields ?? {};
    const s = (k) => f[k]?.stringValue ?? '';
    return {
      id: r.document.name.split('/').pop(),
      at: f.createdAt?.timestampValue ?? '',
      screen: s('screen'),
      name: s('name'),
      comment: s('comment'),
      ua: s('ua'),
    };
  });

console.log(`COUNT=${rows.length}`);
for (const r of rows) {
  console.log('---');
  console.log(`${r.at}  [${r.screen || 'sin pantalla'}]  ${r.name || 'anónimo'}`);
  console.log(r.comment);
}
if (!rows.length) console.log('(no feedback yet)');
