/**
 * Pins every branch of the health checker's decisions, including the ones that
 * must report OK. A monitoring check whose own decision function rots keeps
 * printing ✓ — the exact silence it exists to detect (same reasoning as
 * check-registry-funpay-deployed.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHealth,
  classifyHosting,
  classifySecret,
  overallVerdict,
  loadEndpoints,
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
