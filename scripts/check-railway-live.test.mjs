/**
 * Pins every branch of the Railway reconciler's decisions — including the
 * OK branches and both "could not observe" branches, because a reconciler
 * that answers confidently from a failed read is wrong in whichever
 * direction it defaults (the lesson check-registry-funpay-deployed.mjs
 * documents from live incidents).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostOf, bindServices, bindingVerdict, overallVerdict } from './check-railway-live.mjs';

const CANONICAL = { 'payment-server': 'https://payment-server-production-b9b8.up.railway.app' };

const liveService = (over = {}) => ({
  id: 'svc-1234567890',
  name: 'payment-server',
  projectName: 'observant-miracle',
  environmentName: 'production',
  domains: ['payment-server-production-b9b8.up.railway.app'],
  activeDeployments: [{ status: 'SUCCESS' }],
  ...over,
});

/* ── hostOf ───────────────────────────────────────────────────────────────── */

test('hostOf lowercases and strips scheme/path', () => {
  assert.equal(hostOf('https://Payment-Server-Production-B9B8.up.railway.app/health'), 'payment-server-production-b9b8.up.railway.app');
});

test('hostOf is null on garbage rather than throwing', () => {
  assert.equal(hostOf('not a url'), null);
});

/* ── bindServices ─────────────────────────────────────────────────────────── */

test('binds by domain first, even when the name would not match', () => {
  const [b] = bindServices(CANONICAL, [liveService({ name: 'totally-renamed' })]);
  assert.equal(b.via, 'domain');
  assert.equal(b.service.name, 'totally-renamed');
});

test('falls back to name matching across naming schemes (vida-payment-server)', () => {
  const [b] = bindServices(CANONICAL, [liveService({ name: 'vida-payment-server', domains: [] })]);
  assert.equal(b.via, 'name');
});

test('an unserved canonical URL binds to nothing', () => {
  const [b] = bindServices(CANONICAL, [liveService({ name: 'unrelated', domains: ['elsewhere.example'] })]);
  assert.equal(b.service, null);
});

/* ── bindingVerdict ───────────────────────────────────────────────────────── */

test('domain-bound with an active deployment is ok', () => {
  const [b] = bindServices(CANONICAL, [liveService()]);
  assert.equal(bindingVerdict(b).status, 'ok');
});

test('domain-bound with ZERO active deployments is a mismatch — nothing is running', () => {
  const [b] = bindServices(CANONICAL, [liveService({ activeDeployments: [] })]);
  const v = bindingVerdict(b);
  assert.equal(v.status, 'mismatch');
  assert.match(v.reason, /NO active deployment/);
});

test('domain-bound with unreadable deployments is UNKNOWN, not a pass and not a mismatch', () => {
  const [b] = bindServices(CANONICAL, [liveService({ activeDeployments: null })]);
  assert.equal(bindingVerdict(b).status, 'unknown');
});

test('name-bound whose domains do NOT include the canonical host is a mismatch', () => {
  const [b] = bindServices(CANONICAL, [liveService({ name: 'vida-payment-server', domains: ['payment-server-production-91c7.up.railway.app'] })]);
  const v = bindingVerdict(b);
  assert.equal(v.status, 'mismatch');
  assert.match(v.reason, /by NAME/);
});

test('name-bound with unreadable domains is UNKNOWN — an unread list proves nothing', () => {
  const [b] = bindServices(CANONICAL, [liveService({ name: 'vida-payment-server', domains: null })]);
  assert.equal(bindingVerdict(b).status, 'unknown');
});

test('unbound is a mismatch naming the orphaned host', () => {
  const [b] = bindServices(CANONICAL, []);
  const v = bindingVerdict(b);
  assert.equal(v.status, 'mismatch');
  assert.match(v.reason, /payment-server-production-b9b8/);
});

/* ── overallVerdict ───────────────────────────────────────────────────────── */

test('nothing observed at all is exit 2, never a pass', () => {
  assert.equal(overallVerdict([], false).exit, 2);
});

test('any mismatch is exit 1 and outranks unknowns', () => {
  assert.equal(overallVerdict([{ status: 'ok' }, { status: 'unknown' }, { status: 'mismatch' }], true).exit, 1);
});

test('unknown without mismatch is exit 2 — a missing observation is not outvoted by readable peers', () => {
  assert.equal(overallVerdict([{ status: 'ok' }, { status: 'unknown' }], true).exit, 2);
});

test('all ok is exit 0', () => {
  assert.equal(overallVerdict([{ status: 'ok' }, { status: 'ok' }], true).exit, 0);
});
