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

import {
  reconcile,
  pathsToPathspecs,
  liveDeployment,
  classifyContainment,
} from './check-registry-funpay-deployed.mjs';

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
      containment: 'not-contained',
    });
    assert.equal(v.status, 'stale');
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
      containment: 'contained',
    });
    assert.equal(v.status, 'ok');
    assert.match(v.reason, /contains/);
  });

  it('FAILS when Railway reports no deployment at all', () => {
    // A recreated service gets a new id, and the old id then returns nothing.
    // Reporting that as "nothing to check" would be the silent direction.
    const v = reconcile({ deployedCommit: null, requiredCommit: B, containment: 'not-contained' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /no deployment/i);
  });

  it('passes vacuously, and says so, when nothing has ever touched the paths', () => {
    // Genuinely fine — but it must not read as a verified pass, because the
    // check did not verify anything.
    const v = reconcile({ deployedCommit: A, requiredCommit: null, containment: 'not-contained' });
    assert.equal(v.status, 'ok');
    assert.match(v.reason, /No commit on main has touched/);
  });

  it('says UNKNOWN, not STALE, when the deployed commit cannot be resolved', () => {
    // The loud-but-wrong-cause defect. rc=128 ("not a valid commit name") used to
    // collapse into `false` and print "the deploy workflow did not fire" — sending
    // someone to fix a trigger that is fine, over what is really a git problem.
    const v = reconcile({ deployedCommit: A, requiredCommit: B, containment: 'unresolvable' });
    assert.equal(v.status, 'unknown');
    assert.equal(v.ok, false);
    assert.doesNotMatch(v.reason, /STALE/);
    assert.doesNotMatch(v.reason, /did not fire/);
    assert.match(v.reason, /UNKNOWN/);
    assert.match(v.reason, /NOT a staleness claim/);
    // The remedies must be named, or the reader has a verdict and no next step.
    assert.match(v.reason, /shallow/);
  });

  it('refuses to answer when liveness is not established, whatever the commits say', () => {
    // Precedence matters: a containment result computed from a commit that is not
    // running is not evidence, so liveness is checked FIRST. If this branch fell
    // through to the containment branch it would report a confident OK about a
    // deployment that is not serving traffic.
    const v = reconcile({
      deployedCommit: A,
      requiredCommit: B,
      containment: 'contained',
      liveness: { status: 'none', reason: 'Railway reports NO active deployment' },
    });
    assert.equal(v.status, 'unknown');
    assert.match(v.reason, /NO active deployment/);
  });
});

describe('liveDeployment — running, not newest', () => {
  it('refuses when nothing is running', () => {
    for (const actives of [[], null, undefined]) {
      const l = liveDeployment(actives);
      assert.equal(l.status, 'none');
      assert.match(l.reason, /not a pass/i);
    }
  });

  it('refuses when an active deployment carries no commit hash', () => {
    // Image-based or manually-uploaded deploys look like this. Treating a missing
    // commit as "no required commit" would pass vacuously on a live service.
    const l = liveDeployment([{ id: 'dddddddd', status: 'SUCCESS', commit: null }]);
    assert.equal(l.status, 'no-commit');
    assert.match(l.reason, /commitHash/);
  });

  it('returns EVERY active deployment, so a lagging replica cannot be hidden', () => {
    // During a rolling deploy two deployments can be active. "One of the two is
    // current" is not current — traffic can land on either.
    const l = liveDeployment([
      { id: 'newer', status: 'SUCCESS', commit: A },
      { id: 'older', status: 'SUCCESS', commit: B },
    ]);
    assert.equal(l.status, 'live');
    assert.equal(l.deployments.length, 2);
  });
});

describe('classifyContainment', () => {
  it('discriminates the three exit codes git actually returns', () => {
    // Measured live on this repo: 0 contained, 1 not contained, 128 bad object.
    assert.equal(classifyContainment(0), 'contained');
    assert.equal(classifyContainment(1), 'not-contained');
    assert.equal(classifyContainment(128), 'unresolvable');
  });

  it('treats a spawn failure (no exit code at all) as unresolvable, not as not-contained', () => {
    // git missing from PATH throws with no `status`. Folding that into `false`
    // would report the service stale because the checker is broken.
    assert.equal(classifyContainment(null), 'unresolvable');
    assert.equal(classifyContainment(undefined), 'unresolvable');
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
