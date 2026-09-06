/**
 * Pins the recovery planner's one load-bearing rule — a service with any
 * active deployment is NEVER acted on — plus every branch around it. A
 * repairer whose guard rots doesn't print a wrong tick; it redeploys healthy
 * production money services, so these run as a hard gate before the script
 * ever talks to Railway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bindServices } from './check-railway-live.mjs';
import { planRecovery, recoveryVerdict } from './recover-production-services.mjs';

const CANONICAL = { 'payment-server': 'https://payment-server-production-b9b8.up.railway.app' };

const svc = (over = {}) => ({
  id: 'svc-1',
  name: 'payment-server',
  projectName: 'observant-miracle',
  environmentName: 'production',
  environmentId: 'env-1',
  domains: ['payment-server-production-b9b8.up.railway.app'],
  activeDeployments: [{ status: 'SUCCESS' }],
  ...over,
});

const redis = (over = {}) => ({
  id: 'svc-redis',
  name: 'Redis',
  projectName: 'observant-miracle',
  environmentName: 'production',
  environmentId: 'env-1',
  domains: [],
  activeDeployments: [],
  ...over,
});

function plan(services) {
  return planRecovery(bindServices(CANONICAL, services), services);
}

/* ── the never-touch rule ─────────────────────────────────────────────── */

test('a running service is action none — never deployed over', () => {
  const [p] = plan([svc()]);
  assert.equal(p.action, 'none');
});

test('a running Redis is action none', () => {
  const running = [svc(), redis({ activeDeployments: [{ status: 'SUCCESS' }] })];
  const actions = plan(running).map((p) => p.action);
  assert.deepEqual(actions, ['none', 'none']);
});

/* ── what gets recovered ──────────────────────────────────────────────── */

test('a bound service with zero active deployments gets a deploy', () => {
  const [p] = plan([svc({ activeDeployments: [] })]);
  assert.equal(p.action, 'deploy');
  assert.equal(p.service.id, 'svc-1');
});

test('a dead Redis in an environment hosting a bound service gets a redeploy', () => {
  const result = plan([svc(), redis()]);
  const r = result.find((p) => p.name.startsWith('Redis'));
  assert.equal(r.action, 'redeploy');
});

test('a dead Redis in an UNRELATED project is left alone entirely', () => {
  const result = plan([svc(), redis({ projectName: 'marcable' })]);
  assert.equal(result.find((p) => p.name.startsWith('Redis')), undefined);
});

/* ── unobservables stay manual ────────────────────────────────────────── */

test('unreadable deployment state is manual, never a deploy', () => {
  const [p] = plan([svc({ activeDeployments: null })]);
  assert.equal(p.action, 'manual');
});

test('an unbound canonical URL is manual — nothing safe to deploy', () => {
  const [p] = plan([]);
  assert.equal(p.action, 'manual');
});

test('a Redis with unreadable state is manual', () => {
  const result = plan([svc(), redis({ activeDeployments: null })]);
  const r = result.find((p) => p.name.startsWith('Redis'));
  assert.equal(r.action, 'manual');
});

/* ── verdicts ───────────────────────────────────────────────────────────── */

test('nothing needed is exit 0', () => {
  const v = recoveryVerdict([{ action: 'none' }], []);
  assert.equal(v.exit, 0);
});

test('all recoveries confirmed live is exit 0', () => {
  const v = recoveryVerdict([{ action: 'deploy' }], [{ ok: true }]);
  assert.equal(v.exit, 0);
});

test('an unconfirmed recovery is exit 1 — submitted is not recovered', () => {
  const v = recoveryVerdict([{ action: 'deploy' }], [{ ok: false, why: 'timeout' }]);
  assert.equal(v.exit, 1);
});

test('a manual item is exit 1 even when everything else recovered', () => {
  const v = recoveryVerdict([{ action: 'deploy' }, { action: 'manual' }], [{ ok: true }]);
  assert.equal(v.exit, 1);
});
