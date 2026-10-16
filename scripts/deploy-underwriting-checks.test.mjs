/**
 * Tests for deploy-underwriting-checks.mjs — which Railway service the
 * underwriting deploy targets, and whether /health proves the deploy is live.
 *
 * Both decisions guard production. The resolver is the only thing standing
 * between "deploy underwriting" and "deploy whatever service happened to match",
 * so most of these cases are refusals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickService, healthVerdict, hostOf, ENDPOINT_KEY } from './deploy-underwriting-checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'deploy-underwriting-checks.mjs');
const HOST = 'underwriting-service-production.up.railway.app';
const NAME = 'underwriting-service';

const UW = { id: 'uw-id', name: NAME, domains: [HOST] };
const OTHER = { id: 'pay-id', name: 'payment-server', domains: ['payment-server-production-b9b8.up.railway.app'] };

describe('pickService', () => {
  it('picks the one service serving the canonical host', () => {
    assert.deepEqual(pickService([OTHER, UW], { host: HOST, name: NAME }), { id: 'uw-id', name: NAME });
  });

  it('matches the host case-insensitively', () => {
    const upper = { ...UW, domains: [HOST.toUpperCase()] };
    assert.equal(pickService([upper], { host: HOST, name: NAME }).id, 'uw-id');
  });

  it('refuses when nothing serves the host', () => {
    const { id, error } = pickService([OTHER], { host: HOST, name: NAME });
    assert.equal(id, undefined);
    assert.match(error, /no service in this environment serves/);
  });

  it('refuses when two services claim the host', () => {
    const twin = { ...UW, id: 'uw-twin' };
    const { id, error } = pickService([UW, twin], { host: HOST, name: NAME });
    assert.equal(id, undefined);
    assert.match(error, /2 services serve/);
  });

  it('refuses when the host is served by a service with a different name', () => {
    // Domain and name are two independent claims about identity. When they
    // disagree, deploying either one is a guess.
    const renamed = { ...UW, name: 'pdf-generator' };
    const { id, error } = pickService([renamed], { host: HOST, name: NAME });
    assert.equal(id, undefined);
    assert.match(error, /served by "pdf-generator"/);
  });

  it('refuses rather than skipping a service whose domains could not be read', () => {
    // Skipping it would let one failed read turn an ambiguous inventory into a
    // confident unique match.
    const blind = { id: 'x', name: 'mystery', domains: null };
    const { id, error } = pickService([UW, blind], { host: HOST, name: NAME });
    assert.equal(id, undefined);
    assert.match(error, /could not be read for "mystery"/);
  });

  it('refuses when there is no canonical host or no services at all', () => {
    assert.match(pickService([UW], { host: null, name: NAME }).error, /no canonical host/);
    assert.match(pickService([], { host: HOST, name: NAME }).error, /listed no services/);
  });

  it('reads the real production-endpoints.json entry', () => {
    // If the key or URL moves, the workflow's resolve step breaks; this breaks first.
    const endpoints = JSON.parse(readFileSync(join(HERE, 'production-endpoints.json'), 'utf8'));
    assert.equal(hostOf(endpoints.services[ENDPOINT_KEY]), HOST);
  });
});

const SHA = '427185d0c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
const OLD_SHA = '878bb86aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_DEPLOY = 'new-deployment-id';
const OLD_DEPLOY = 'old-deployment-id';

describe('healthVerdict', () => {
  it('matches when /health reports the deployed commit from the new deployment', () => {
    const v = healthVerdict({ commit: SHA, deploymentId: NEW_DEPLOY }, { commit: SHA, deploymentId: NEW_DEPLOY });
    assert.equal(v.verdict, 'match');
  });

  it('matches regardless of sha case', () => {
    assert.equal(healthVerdict({ commit: SHA }, { commit: SHA.toUpperCase() }).verdict, 'match');
  });

  it('waits while a build from before the commit field is still answering', () => {
    const v = healthVerdict({ status: 'ok', service: 'vida-underwriting-service' }, { commit: SHA, deploymentId: NEW_DEPLOY });
    assert.equal(v.verdict, 'wait');
  });

  it('waits while the previous deployment answers with the previous commit', () => {
    const v = healthVerdict({ commit: OLD_SHA, deploymentId: OLD_DEPLOY }, { commit: SHA, deploymentId: NEW_DEPLOY });
    assert.equal(v.verdict, 'wait');
  });

  it('fails when the NEW deployment reports a different commit', () => {
    const v = healthVerdict({ commit: OLD_SHA, deploymentId: NEW_DEPLOY }, { commit: SHA, deploymentId: NEW_DEPLOY });
    assert.equal(v.verdict, 'fail');
  });

  it('fails when the new deployment reports "unknown" — waiting would never end', () => {
    const v = healthVerdict({ commit: 'unknown', deploymentId: NEW_DEPLOY }, { commit: SHA, deploymentId: NEW_DEPLOY });
    assert.equal(v.verdict, 'fail');
    assert.match(v.reason, /RAILWAY_GIT_COMMIT_SHA/);
  });

  it('fails when Railway gave no usable commit to compare against', () => {
    assert.equal(healthVerdict({ commit: SHA }, { commit: 'unknown' }).verdict, 'fail');
    assert.equal(healthVerdict({ commit: SHA }, { commit: '' }).verdict, 'fail');
  });

  it('never matches an "unknown" commit', () => {
    assert.notEqual(healthVerdict({ commit: 'unknown' }, { commit: SHA }).verdict, 'match');
  });

  it('waits on a body that is not JSON', () => {
    assert.equal(healthVerdict(null, { commit: SHA }).verdict, 'wait');
  });
});

describe('CLI', () => {
  function run(args) {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('resolve prints the id, and health uses the documented exit codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uw-deploy-'));
    try {
      writeFileSync(join(dir, 'services.json'), JSON.stringify([OTHER, UW]));
      writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ services: { [ENDPOINT_KEY]: `https://${HOST}` } }));
      const ok = run(['resolve', join(dir, 'services.json'), join(dir, 'endpoints.json'), NAME]);
      assert.equal(ok.code, 0, ok.out);
      assert.equal(ok.out.trim(), 'uw-id');

      const bad = run(['resolve', join(dir, 'services.json'), join(dir, 'endpoints.json'), 'some-other-name']);
      assert.equal(bad.code, 1);
      assert.match(bad.out, /::error::/);

      writeFileSync(join(dir, 'health.json'), JSON.stringify({ commit: SHA, deploymentId: NEW_DEPLOY }));
      assert.equal(run(['health', join(dir, 'health.json'), SHA, NEW_DEPLOY]).code, 0);
      writeFileSync(join(dir, 'health.json'), JSON.stringify({ commit: OLD_SHA, deploymentId: OLD_DEPLOY }));
      assert.equal(run(['health', join(dir, 'health.json'), SHA, NEW_DEPLOY]).code, 3);
      writeFileSync(join(dir, 'health.json'), JSON.stringify({ commit: OLD_SHA, deploymentId: NEW_DEPLOY }));
      assert.equal(run(['health', join(dir, 'health.json'), SHA, NEW_DEPLOY]).code, 1);
      writeFileSync(join(dir, 'health.json'), '<html>502</html>');
      assert.equal(run(['health', join(dir, 'health.json'), SHA, NEW_DEPLOY]).code, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
