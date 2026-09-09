/**
 * cloudflare-access.mjs — put alfa.funpay.mx behind Cloudflare Access.
 *
 * Access is an EDGE gate: Cloudflare authenticates the visitor against the
 * configured identity provider and evaluates the policy before it proxies
 * anything to the origin. A request without a valid session never reaches
 * Firebase Hosting, so nothing is fetchable by URL — not the portal HTML,
 * not the credentials printed on it, not /web/ or /app/ inside it. A
 * sign-in gate rendered inside the page cannot make that claim: the HTML
 * still ships to anyone who runs curl.
 *
 * MODES
 *   status  — what is configured right now: application, policies, IdPs,
 *             and whether DNS actually routes through Cloudflare
 *   idp     — create/update the Google identity provider from
 *             GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
 *   apply   — create/update the application and its allowlist policy
 *   verify  — prove it from outside: an anonymous request must NOT get the
 *             page back
 *   remove  — delete the application; the site is public again
 *
 * Env: CF_ACCOUNT, CF_TOKEN (account-scoped, Access: Apps and Policies →
 * Edit, and Access: Organizations, Identity Providers and Groups → Edit for
 * `idp`), MODE, HOSTNAME, EMAILS, DOMAINS.
 *
 * Zero dependencies, like the other infra scripts here.
 */
const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = process.env.CF_ACCOUNT;
const TOKEN = process.env.CF_TOKEN;
const MODE = process.env.MODE || 'status';
const HOSTNAME = process.env.HOSTNAME || 'alfa.funpay.mx';
const APP_NAME = 'FunPay team portal';
const ACME_APP_NAME = 'FunPay portal — ACME challenge (bypass)';
const ACME_PATH = '/.well-known/acme-challenge';
const POLICY_NAME = 'FunPay reviewers';

const list = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const EMAILS = list(process.env.EMAILS);
const DOMAINS = list(process.env.DOMAINS);

// `verify` is the one mode that proves the gate from outside, so it must not
// need a token — it is exactly what a stranger can do.
if (MODE !== 'verify' && (!ACCOUNT || !TOKEN)) {
  console.error(
    'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCESS_TOKEN.\n' +
      'The CLOUDFLARE_API_TOKEN used for DNS is zone-scoped and cannot manage\n' +
      'Access — this needs an account-scoped token with\n' +
      '  Access: Apps and Policies → Edit\n' +
      '  Access: Organizations, Identity Providers and Groups → Edit'
  );
  process.exit(1);
}

async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    console.error(`${method} ${path} failed (HTTP ${r.status})`);
    console.error(JSON.stringify(j.errors ?? j, null, 2));
    process.exit(1);
  }
  return j.result;
}

/* Access can only act on traffic Cloudflare actually sees. A DNS-only
   (grey-cloud) record hands the visitor straight to Firebase and the policy
   never runs — the single most likely way for this to look configured and
   protect nothing. */
async function proxyState() {
  const zoneName = HOSTNAME.split('.').slice(-2).join('.');
  try {
    const zones = await cf('GET', `/zones?name=${zoneName}`);
    const zone = zones?.[0];
    if (!zone) return { known: false, why: `no access to zone ${zoneName}` };
    const recs = await cf('GET', `/zones/${zone.id}/dns_records?name=${HOSTNAME}`);
    if (!recs?.length) return { known: false, why: `no DNS record for ${HOSTNAME}` };
    return { known: true, proxied: recs.some((r) => r.proxied), zoneId: zone.id, records: recs };
  } catch {
    return { known: false, why: 'token cannot read DNS (zone permissions not granted)' };
  }
}

async function anonymousFetch() {
  const r = await fetch(`https://${HOSTNAME}/`, { redirect: 'manual' });
  const body = r.status === 200 ? await r.text() : '';
  return { status: r.status, location: r.headers.get('location') || '', body };
}

// ---------------------------------------------------------------- verify
if (MODE === 'verify') {
  const { status, location, body } = await anonymousFetch();
  const gated =
    (status >= 300 && status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location)) ||
    (status === 403 && !body.includes('FunPay'));
  console.log(`anonymous GET https://${HOSTNAME}/ → ${status}${location ? ` → ${location}` : ''}`);
  if (gated) {
    console.log('\n✓ GATED — a stranger is sent to sign in and gets no page.');
    process.exit(0);
  }
  if (status === 200) {
    const leaked = /Contraseña|FunPay-Ops-|FunPay-Empleador-|QaUi-/.test(body);
    console.error(
      `\n✗ NOT GATED — the page came back to an anonymous request` +
        (leaked ? ', credentials and all.' : '.')
    );
  } else {
    console.error(`\n✗ Unexpected response ${status}; not a recognisable Access challenge.`);
  }
  process.exit(1);
}

const apps = await cf('GET', `/accounts/${ACCOUNT}/access/apps`);
let app = (apps || []).find((a) => a.domain === HOSTNAME);
const idps = await cf('GET', `/accounts/${ACCOUNT}/access/identity_providers`);
const google = (idps || []).filter((i) => i.type === 'google' || i.type === 'google-apps');

// ---------------------------------------------------------------- status
if (MODE === 'status') {
  console.log(`Hostname: ${HOSTNAME}\n`);
  const dns = await proxyState();
  if (!dns.known) console.log(`DNS: unknown (${dns.why})`);
  else if (dns.proxied) console.log('DNS: PROXIED — Cloudflare sees the traffic, Access can enforce.');
  else console.log('DNS: DNS-ONLY (grey cloud) — Access CANNOT enforce until this is proxied.');

  const acmeApp = (apps || []).find((a) => a.domain === `${HOSTNAME}${ACME_PATH}`);
  console.log(
    acmeApp
      ? 'ACME bypass: present — the origin certificate can still renew.'
      : 'ACME bypass: MISSING — once proxied, certificate renewal will be answered with a login page.'
  );
  if (!app) {
    console.log('\nNOT PROTECTED — no Access application for this hostname.');
  } else {
    console.log(`\nApplication: ${app.name} (${app.id}), session ${app.session_duration}`);
    const policies = await cf('GET', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`);
    for (const p of policies || []) {
      console.log(`\nPolicy "${p.name}" — ${p.decision}`);
      for (const inc of p.include || []) console.log('  allow:', JSON.stringify(inc));
    }
  }
  console.log(
    '\nIdentity providers:',
    (idps || []).map((i) => `${i.name} (${i.type})`).join(', ') || 'NONE CONFIGURED'
  );
  const { status, location } = await anonymousFetch();
  console.log(`\nAnonymous request → ${status}${location ? ` → ${location}` : ''}`);
  process.exit(0);
}

// ---------------------------------------------------------------- remove
if (MODE === 'remove') {
  if (!app) {
    console.log(`Nothing to remove — ${HOSTNAME} has no Access application.`);
    process.exit(0);
  }
  await cf('DELETE', `/accounts/${ACCOUNT}/access/apps/${app.id}`);
  const acmeApp = (apps || []).find((a) => a.domain === `${HOSTNAME}${ACME_PATH}`);
  if (acmeApp) await cf('DELETE', `/accounts/${ACCOUNT}/access/apps/${acmeApp.id}`);
  console.log(`REMOVED Access from ${HOSTNAME}. The site is public again.`);
  process.exit(0);
}

// ------------------------------------------------------------------- idp
if (MODE === 'idp') {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      'Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.\n\n' +
        'Create them in Google Cloud console → APIs & Services → Credentials →\n' +
        'OAuth client ID → Web application, with this redirect URI:\n' +
        `  https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback\n` +
        'The team name is in Zero Trust → Settings → Custom Pages (team domain).'
    );
    process.exit(1);
  }
  const payload = {
    name: 'Google',
    type: 'google',
    config: { client_id: clientId, client_secret: clientSecret },
  };
  const existing = google[0];
  const result = existing
    ? await cf('PUT', `/accounts/${ACCOUNT}/access/identity_providers/${existing.id}`, payload)
    : await cf('POST', `/accounts/${ACCOUNT}/access/identity_providers`, payload);
  console.log(`${existing ? 'Updated' : 'Created'} Google identity provider (${result.id}).`);
  process.exit(0);
}

// ----------------------------------------------------------------- apply
// An empty allowlist is refused rather than turned into a policy whose
// meaning nobody can predict.
if (!EMAILS.length && !DOMAINS.length) {
  console.error('Refusing to apply: both `emails` and `domains` are empty.');
  process.exit(1);
}

// Pin Google and send people straight to it — but only once Google exists.
// Pinning an IdP that is not configured yet locks everyone out of the login
// page itself, which is a bad way to find out.
const allowed_idps = google.map((i) => i.id);
const appPayload = {
  name: APP_NAME,
  domain: HOSTNAME,
  type: 'self_hosted',
  session_duration: '24h',
  allowed_idps,
  auto_redirect_to_identity: allowed_idps.length === 1,
  app_launcher_visible: true,
};

app = app
  ? await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${app.id}`, appPayload)
  : await cf('POST', `/accounts/${ACCOUNT}/access/apps`, appPayload);
console.log(`Access application ready for ${HOSTNAME} (${app.id})`);

/* Firebase Hosting renews the origin certificate itself, over an HTTP-01
   challenge served from /.well-known/acme-challenge. Once this hostname is
   proxied, that challenge arrives through Cloudflare — and if Access is
   guarding the whole hostname it answers Let's Encrypt with a login page.
   Nothing breaks on the day it is switched on; the certificate simply fails
   to renew two months later and the origin goes untrusted. A bypass
   application scoped to that one path, at higher precedence, keeps the
   renewal reachable. It exposes only the challenge tokens, which are
   public by design. */
const acmeDomain = `${HOSTNAME}${ACME_PATH}`;
let acme = (apps || []).find((a) => a.domain === acmeDomain);
const acmePayload = {
  name: ACME_APP_NAME,
  domain: acmeDomain,
  type: 'self_hosted',
  session_duration: '24h',
  app_launcher_visible: false,
};
acme = acme
  ? await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${acme.id}`, acmePayload)
  : await cf('POST', `/accounts/${ACCOUNT}/access/apps`, acmePayload);
const acmePolicies = await cf('GET', `/accounts/${ACCOUNT}/access/apps/${acme.id}/policies`);
const acmeRule = {
  name: 'Certificate renewal',
  decision: 'bypass',
  include: [{ everyone: {} }],
  precedence: 1,
};
if (acmePolicies?.length) {
  await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${acme.id}/policies/${acmePolicies[0].id}`, acmeRule);
} else {
  await cf('POST', `/accounts/${ACCOUNT}/access/apps/${acme.id}/policies`, acmeRule);
}
console.log(`Bypass in place for ${acmeDomain} so the origin certificate keeps renewing.`);

const include = [
  ...EMAILS.map((email) => ({ email: { email } })),
  ...DOMAINS.map((domain) => ({ email_domain: { domain } })),
];
const policies = await cf('GET', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`);
const existing = (policies || []).find((p) => p.name === POLICY_NAME);
const policyPayload = { name: POLICY_NAME, decision: 'allow', include, precedence: 1 };
if (existing) {
  await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies/${existing.id}`, policyPayload);
  console.log(`Updated policy "${POLICY_NAME}".`);
} else {
  await cf('POST', `/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, policyPayload);
  console.log(`Created policy "${POLICY_NAME}".`);
}

console.log(`\n${HOSTNAME} now allows:`);
for (const e of EMAILS) console.log('  •', e);
for (const d of DOMAINS) console.log('  • anyone @' + d);

if (!google.length) {
  console.log(
    '\nWARNING: no Google identity provider on this account, so the login page\n' +
      "will only offer Cloudflare's one-time email PIN. Run mode=idp to add Google."
  );
}

const dns = await proxyState();
if (dns.known && !dns.proxied) {
  console.log(
    `\n⚠️  ${HOSTNAME} is still DNS-ONLY. Access is configured but enforces NOTHING\n` +
      '   until the record is proxied (orange cloud). Flip it, then run mode=verify.'
  );
} else if (!dns.known) {
  console.log(`\nCould not check the DNS record (${dns.why}) — confirm it is proxied, then run mode=verify.`);
} else {
  console.log('\nDNS is proxied. Run mode=verify to prove a stranger gets nothing.');
}
