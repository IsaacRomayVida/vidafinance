/**
 * Pins every branch of the health checker's decisions, including the ones that
 * must report OK. A monitoring check whose own decision function rots keeps
 * printing ✓ — the exact silence it exists to detect (same reasoning as
 * check-registry-funpay-deployed.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyHealth,
  classifyHosting,
  classifySecret,
  overallVerdict,
  loadEndpoints,
  collectRows,
  probe,
} from './check-production-health.mjs';

/* ── classifyHealth ───────────────────────────────────────────────────────── */

test('a 200 with status ok and redis true is healthy', () => {
  const v = classifyHealth({ httpStatus: 200, body: { status: 'ok', redis: true } });
  assert.equal(v.status, 'ok');
});

test('a 200 with status ok and NO redis field is healthy — absent is not false', () => {
  const v = classifyHealth({ httpStatus: 200, body: { status: 'ok' } });
  assert.equal(v.status, 'ok');
});

test('redis:false fails — queues dead is an outage, not a warning', () => {
  const v = classifyHealth({ httpStatus: 200, body: { status: 'ok', redis: false } });
  assert.equal(v.status, 'down');
  assert.match(v.reason, /redis=false/);
});

test('a non-JSON 200 is healthy (liveness, pre-contract services)', () => {
  const v = classifyHealth({ httpStatus: 200, body: null });
  assert.equal(v.status, 'ok');
});

test('HTTP 404 is down — the chronic condition this check was built for', () => {
  const v = classifyHealth({ httpStatus: 404, body: null });
  assert.equal(v.status, 'down');
  assert.equal(v.reason, 'HTTP 404');
});

test('a transport error is down, with the error surfaced', () => {
  const v = classifyHealth({ error: 'ETIMEDOUT' });
  assert.equal(v.status, 'down');
  assert.match(v.reason, /ETIMEDOUT/);
});

test('status other than ok is down even on a 200', () => {
  const v = classifyHealth({ httpStatus: 200, body: { status: 'degraded' } });
  assert.equal(v.status, 'down');
});

/* ── classifyHosting ──────────────────────────────────────────────────────── */

test('hosting 200 containing the app shell marker is healthy', () => {
  const v = classifyHosting({ httpStatus: 200, text: '<div id="root"></div>' }, 'id="root"');
  assert.equal(v.status, 'ok');
});

test('hosting 200 WITHOUT the marker is down — an empty 200 is not the app', () => {
  const v = classifyHosting({ httpStatus: 200, text: '<html>placeholder</html>' }, 'id="root"');
  assert.equal(v.status, 'down');
});

test('hosting non-200 is down', () => {
  const v = classifyHosting({ httpStatus: 503, text: '' }, 'id="root"');
  assert.equal(v.status, 'down');
});

/* ── classifySecret ───────────────────────────────────────────────────────── */

test('a matching secret matches, trailing slash tolerated', () => {
  const v = classifySecret('https://a.example', 'https://a.example/');
  assert.equal(v.status, 'match');
});

test('an absent secret is absent — reported, never failed', () => {
  const v = classifySecret('https://a.example', undefined);
  assert.equal(v.status, 'absent');
});

test('a different URL is drift, naming both sides', () => {
  const v = classifySecret('https://a.example', 'https://b.example');
  assert.equal(v.status, 'drift');
  assert.match(v.reason, /a\.example/);
  assert.match(v.reason, /b\.example/);
});

/* ── overallVerdict ───────────────────────────────────────────────────────── */

test('all healthy rows pass', () => {
  const v = overallVerdict([{ fail: false }, { fail: false }]);
  assert.equal(v.ok, true);
});

test('one failing row fails the whole verdict and lists it', () => {
  const v = overallVerdict([{ fail: false }, { fail: true, name: 'x', reason: 'HTTP 404' }]);
  assert.equal(v.ok, false);
  assert.equal(v.failures.length, 1);
});

/* ── the canonical file itself ────────────────────────────────────────────── */

test('production-endpoints.json parses and covers all six services + hosting', () => {
  const e = loadEndpoints();
  assert.ok(e.hosting.url.startsWith('https://'));
  assert.ok(e.hosting.mustContain.length > 0);
  const names = Object.keys(e.services);
  assert.deepEqual(
    names.sort(),
    [
      'ml-service',
      'notification-service',
      'payment-server',
      'pdf-generator',
      'softcredito-adapter',
      'underwriting-service',
    ]
  );
  for (const name of names) {
    assert.ok(e.services[name].startsWith('https://'), `${name} has an https URL`);
    assert.ok(e.secretNames[name], `${name} maps to a secret name`);
  }
});

test('production-endpoints.json records registry-service apart from `services`', () => {
  const e = loadEndpoints();
  assert.match(e.registry.url, /^https:\/\/[^/]+$/, 'https origin, no path or trailing slash');
  assert.equal(e.registry.secretName, 'REGISTRY_SERVICE_URL');
  // In `services` it would be written into functions/.env by deploy.yml next
  // to the REGISTRY_SERVICE_URL secret line, and auto-redeployed by
  // recover-production-services.mjs.
  assert.ok(!Object.values(e.services).includes(e.registry.url));
  assert.ok(!Object.values(e.secretNames).includes('REGISTRY_SERVICE_URL'));
});

/* ── collectRows: which rows gate, which are informational ────────────────── */
// No network: `probeFn` is a fake keyed by URL, and it records every URL asked for.

const ENDPOINTS = {
  hosting: { url: 'https://site.example', mustContain: 'id="root"' },
  services: { alpha: 'https://alpha.example', beta: 'https://beta.example' },
  secretNames: { alpha: 'ALPHA_URL', beta: 'BETA_URL' },
  registry: { url: 'https://registry.example', secretName: 'REGISTRY_SERVICE_URL' },
};
const HEALTHY = { httpStatus: 200, body: { status: 'ok', redis: true } };
const SHELL = { httpStatus: 200, text: '<div id="root"></div>' };

function fakeProbe(overrides = {}) {
  const calls = [];
  const probeFn = async (url) => {
    calls.push(url);
    if (url in overrides) return overrides[url];
    if (url === ENDPOINTS.hosting.url) return SHELL;
    return HEALTHY;
  };
  return { probeFn, calls };
}
const row = (rows, name) => rows.find((r) => r.name === name);

test('collectRows: everything healthy, no secrets set → no failing row, one probe per endpoint', async () => {
  const { probeFn, calls } = fakeProbe();
  const rows = await collectRows({ endpoints: ENDPOINTS, env: {}, probeFn });

  assert.deepEqual(rows.map((r) => r.name), [
    'canonical:alpha', 'secret:ALPHA_URL',
    'canonical:beta', 'secret:BETA_URL',
    'canonical:registry-service', 'secret:REGISTRY_SERVICE_URL',
    'hosting',
  ]);
  assert.deepEqual(rows.filter((r) => r.fail), []);
  assert.equal(overallVerdict(rows).ok, true);
  assert.deepEqual(calls, [
    'https://alpha.example/health',
    'https://beta.example/health',
    'https://registry.example/health',
    'https://site.example',
  ]);
  assert.match(row(rows, 'secret:REGISTRY_SERVICE_URL').reason, /not set/);
});

test('collectRows: a canonical service answering 404 fails its own row and no other', async () => {
  const { probeFn } = fakeProbe({ 'https://beta.example/health': { httpStatus: 404, body: null } });
  const rows = await collectRows({ endpoints: ENDPOINTS, env: {}, probeFn });

  assert.deepEqual(rows.filter((r) => r.fail).map((r) => r.name), ['canonical:beta']);
  assert.equal(row(rows, 'canonical:beta').reason, 'HTTP 404');
  assert.equal(overallVerdict(rows).ok, false);
});

test('collectRows: a drifted SERVICE secret is informational — never fails, never probed', async () => {
  // Its URL is dead on purpose: if the drifted secret were probed and gated, this would fail.
  const { probeFn, calls } = fakeProbe({ 'https://stale-alpha.example/health': { httpStatus: 404, body: null } });
  const rows = await collectRows({
    endpoints: ENDPOINTS,
    env: { ALPHA_URL: 'https://stale-alpha.example', BETA_URL: 'https://beta.example/' },
    probeFn,
  });

  const alpha = row(rows, 'secret:ALPHA_URL');
  assert.equal(alpha.fail, false);
  assert.match(alpha.reason, /stale-alpha\.example/);
  assert.match(alpha.reason, /informational only/);
  assert.equal(row(rows, 'secret:BETA_URL').reason, 'matches canonical');
  assert.ok(!calls.some((u) => u.includes('stale-alpha')), 'a service secret URL is not probed');
  assert.equal(overallVerdict(rows).ok, true);
});

test('collectRows: a matching registry secret is not probed a second time', async () => {
  const { probeFn, calls } = fakeProbe();
  const rows = await collectRows({
    endpoints: ENDPOINTS,
    env: { REGISTRY_SERVICE_URL: 'https://registry.example/' },
    probeFn,
  });

  assert.deepEqual(row(rows, 'secret:REGISTRY_SERVICE_URL'), {
    name: 'secret:REGISTRY_SERVICE_URL', fail: false, reason: 'matches canonical',
  });
  assert.equal(calls.filter((u) => u.includes('registry')).length, 1);
});

test('collectRows: a drifted registry secret whose URL is HEALTHY is reported but does not fail', async () => {
  const { probeFn, calls } = fakeProbe();
  const rows = await collectRows({
    endpoints: ENDPOINTS,
    env: { REGISTRY_SERVICE_URL: 'https://old-registry.example//' },
    probeFn,
  });

  const secret = row(rows, 'secret:REGISTRY_SERVICE_URL');
  assert.equal(secret.fail, false);
  assert.match(secret.reason, /secret points at https:\/\/old-registry\.example, canonical is https:\/\/registry\.example/);
  assert.match(secret.reason, /the secret's URL is healthy/);
  // trailing slashes trimmed before /health is appended
  assert.ok(calls.includes('https://old-registry.example/health'));
  assert.equal(overallVerdict(rows).ok, true);
});

test('collectRows: a drifted registry secret whose URL is DEAD gates — deploy.yml still reads it', async () => {
  const { probeFn } = fakeProbe({ 'https://old-registry.example/health': { httpStatus: 404, body: null } });
  const rows = await collectRows({
    endpoints: ENDPOINTS,
    env: { REGISTRY_SERVICE_URL: 'https://old-registry.example' },
    probeFn,
  });

  // The canonical registry is healthy; only the secret's own URL is dead.
  assert.equal(row(rows, 'canonical:registry-service').fail, false);
  const secret = row(rows, 'secret:REGISTRY_SERVICE_URL');
  assert.equal(secret.fail, true);
  assert.match(secret.reason, /the secret's URL is HTTP 404/);
  assert.match(secret.reason, /deploy\.yml reads this secret/);
  const verdict = overallVerdict(rows);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.failures.map((f) => f.name), ['secret:REGISTRY_SERVICE_URL']);
});

test('collectRows: a dead canonical registry fails even when the secret matches', async () => {
  const { probeFn } = fakeProbe({ 'https://registry.example/health': { error: 'ENOTFOUND' } });
  const rows = await collectRows({
    endpoints: ENDPOINTS,
    env: { REGISTRY_SERVICE_URL: 'https://registry.example' },
    probeFn,
  });

  assert.deepEqual(rows.filter((r) => r.fail).map((r) => r.name), ['canonical:registry-service']);
  assert.match(row(rows, 'canonical:registry-service').reason, /ENOTFOUND/);
});

test('collectRows: hosting that answers 200 without the app shell fails', async () => {
  const { probeFn } = fakeProbe({ 'https://site.example': { httpStatus: 200, text: '<html>parked</html>' } });
  const rows = await collectRows({ endpoints: ENDPOINTS, env: {}, probeFn });

  assert.deepEqual(rows.filter((r) => r.fail).map((r) => r.name), ['hosting']);
});

test('collectRows covers every endpoint in the real production-endpoints.json (fake probe, no network)', async () => {
  const endpoints = loadEndpoints();
  const calls = [];
  const probeFn = async (url) => {
    calls.push(url);
    return url === endpoints.hosting.url ? { httpStatus: 200, text: endpoints.hosting.mustContain } : HEALTHY;
  };
  const rows = await collectRows({ endpoints, env: {}, probeFn });

  assert.equal(overallVerdict(rows).ok, true);
  assert.deepEqual(
    calls,
    [...Object.values(endpoints.services).map((u) => `${u}/health`), `${endpoints.registry.url}/health`, endpoints.hosting.url]
  );
});

/* ── probe: the one-retry rule, against a fake fetch ──────────────────────── */

function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.text };
  };
  return { fetchImpl, calls };
}
const FAST = { retryDelayMs: 0 };

test('probe: a 200 JSON body is returned parsed, after a single request', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 200, text: '{"status":"ok","redis":true}' });
  const out = await probe('https://alpha.example/health', { fetchImpl, ...FAST });

  assert.deepEqual(out, { httpStatus: 200, body: { status: 'ok', redis: true }, text: '{"status":"ok","redis":true}' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://alpha.example/health');
  assert.equal(calls[0].opts.redirect, 'follow');
  assert.ok(calls[0].opts.signal instanceof AbortSignal, 'every request carries a timeout');
});

test('probe: a non-JSON 200 keeps the text and a null body', async () => {
  const { fetchImpl } = fakeFetch({ status: 200, text: '<div id="root"></div>' });
  const out = await probe('https://site.example', { fetchImpl, ...FAST });

  assert.equal(out.body, null);
  assert.equal(classifyHosting(out, 'id="root"').status, 'ok');
});

test('probe: one bad answer is retried — a cold start is not an outage', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 502, text: 'bad gateway' }, { status: 200, text: '{"status":"ok"}' });
  const out = await probe('https://alpha.example/health', { fetchImpl, ...FAST });

  assert.equal(calls.length, 2);
  assert.equal(classifyHealth(out).status, 'ok');
});

test('probe: two bad answers are reported as the last status, after exactly two requests', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 404, text: 'Not Found' });
  const out = await probe('https://alpha.example/health', { fetchImpl, ...FAST });

  assert.equal(calls.length, 2);
  assert.equal(out.httpStatus, 404);
  assert.deepEqual(classifyHealth(out), { status: 'down', reason: 'HTTP 404' });
});

test('probe: a transport error is retried, then surfaced by its cause code', async () => {
  const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const { fetchImpl, calls } = fakeFetch(err);
  const out = await probe('https://gone.example/health', { fetchImpl, ...FAST });

  assert.equal(calls.length, 2);
  assert.deepEqual(out, { error: 'ENOTFOUND' });
  assert.match(classifyHealth(out).reason, /unreachable: ENOTFOUND/);
});

test('probe: a transport error followed by a 200 recovers', async () => {
  const { fetchImpl, calls } = fakeFetch(new Error('socket hang up'), { status: 200, text: '{"status":"ok"}' });
  const out = await probe('https://alpha.example/health', { fetchImpl, ...FAST });

  assert.equal(calls.length, 2);
  assert.equal(out.httpStatus, 200);
});

test('importing the checker does not run it — main() stays behind the argv guard', () => {
  const src = readFileSync(new URL('./check-production-health.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(invokedDirectly\) await main\(\);/);
});
