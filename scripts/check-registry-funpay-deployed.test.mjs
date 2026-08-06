/**
 * Tests for the deploy reconciler's decision, isolated from Railway and git.
 *
 * The reconciler exists because `deploy-registry-funpay.yml` cannot detect its
 * own non-firing. A reconciler that is itself silently wrong is the same defect
 * one layer up, so the decision is a pure function and every branch of it is
 * pinned here — including the two that must report OK, since a checker that
 * fails on everything is as useless as one that passes on everything.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, pathsToPathspecs } from './check-registry-funpay-deployed.mjs';

const A = 'aaaaaaaa11111111111111111111111111111111';
const B = 'bbbbbbbb22222222222222222222222222222222';

describe('reconcile', () => {
  it('FAILS when a watched-path commit is not contained in the live deployment', () => {
    // The condition the whole check exists for: a merged change to this
    // service's build inputs that never reached production, with no failed run
    // and no alert anywhere else in the system.
    const v = reconcile({
      deployedCommit: A,
      requiredCommit: B,
      deployedContainsRequired: false,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /STALE/);
    assert.match(v.reason, /bbbbbbbb/);
    assert.match(v.reason, /aaaaaaaa/);
    // The message must say why nothing else caught it, or the next reader
    // assumes some other alarm would have.
    assert.match(v.reason, /cannot report its own non-firing/);
  });

  it('passes on CONTAINMENT, not equality', () => {
    // `serviceInstanceDeploy(latestCommit: true)` ships main's head, which is
    // normally newer than the last watched-path commit. Requiring equality would
    // fire on every unrelated commit and train people to ignore this check —
    // which is how a real staleness alert gets missed.
    const v = reconcile({
      deployedCommit: A,
      requiredCommit: B,
      deployedContainsRequired: true,
    });
    assert.equal(v.ok, true);
    assert.match(v.reason, /contains/);
  });

  it('FAILS when Railway reports no deployment at all', () => {
    // A recreated service gets a new id, and the old id then returns nothing.
    // Reporting that as "nothing to check" would be the silent direction.
    const v = reconcile({ deployedCommit: null, requiredCommit: B, deployedContainsRequired: false });
    assert.equal(v.ok, false);
    assert.match(v.reason, /no deployment/i);
  });

  it('passes vacuously, and says so, when nothing has ever touched the paths', () => {
    // Genuinely fine — but it must not read as a verified pass, because the
    // check did not verify anything.
    const v = reconcile({ deployedCommit: A, requiredCommit: null, deployedContainsRequired: false });
    assert.equal(v.ok, true);
    assert.match(v.reason, /No commit on main has touched/);
  });
});

describe('pathsToPathspecs', () => {
  it('turns a directory glob into a pathspec git will accept without glob magic', () => {
    assert.deepEqual(
      pathsToPathspecs(['services/registry-service/**', 'services/shared/**']),
      ['services/registry-service/', 'services/shared/']
    );
  });

  it('leaves exact-file entries alone', () => {
    assert.deepEqual(
      pathsToPathspecs(['.dockerignore', '.github/workflows/deploy-registry-funpay.yml']),
      ['.dockerignore', '.github/workflows/deploy-registry-funpay.yml']
    );
  });
});
