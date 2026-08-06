/**
 * Does the running service actually contain the code that should have deployed?
 *
 * `deploy-registry-funpay.yml` deploys `registry-service-funpay` on pushes to
 * `main` that touch its `paths:` set. That workflow cannot detect its own
 * non-firing: if the trigger is dropped, there is no failed run and no alert —
 * "nothing ran at all", which is the exact sentence in its own header and the
 * six-day staleness it was built to end.
 *
 * The shape showed up immediately, and it is worth stating precisely rather than
 * dramatically. `680d018b` touched
 * `.github/workflows/deploy-registry-funpay.yml` — a path in its own filter — on
 * a push to `main`, so it was a genuinely ELIGIBLE trial, and it drew zero push
 * runs. What reached production was a hand-run `workflow_dispatch`.
 *
 * That is NOT evidence the trigger is broken. GitHub was throttling webhooks to
 * ~15% at the time, and one eligible push drawing nothing is the ~85% outcome —
 * concluding "the trigger never fires" from a single throttled draw is the same
 * absence-as-evidence error this fleet spent the evening retracting in both
 * directions. What is true: **we have never OBSERVED the push trigger fire in
 * production.** That is a gap in evidence, not a defect.
 *
 * The reconciler does not depend on which it is, and that is the point. A deploy
 * that does not happen is silent whatever the cause — dropped webhook, drifted
 * filter, deleted trigger. The dispatch masked the outcome here precisely
 * because the service ended up current: nothing looked wrong, and nothing would
 * have looked wrong if it had not. Detecting the SILENCE is the job; diagnosing
 * why is a separate question this check deliberately does not try to answer.
 *
 * So this check is deliberately built to share no failure mode with the thing it
 * checks:
 *
 *   - It compares Railway's LIVE deployment against git. Both sides are ground
 *     truth; neither is a workflow's own report about itself.
 *   - Its workflow carries NO `paths:` filter. A filtered self-check would be
 *     dropped by exactly the event that drops the deploy, and would go quiet at
 *     the moment it was needed.
 *   - It never deploys. Detecting staleness and fixing it are separate
 *     decisions, and a checker that repairs what it finds cannot be trusted to
 *     report honestly about how often it fires.
 *
 * The `paths:` set is READ FROM THE DEPLOY WORKFLOW, not copied. Two
 * hand-maintained copies of one closure drift silently, and the drift is always
 * toward the checker being narrower than the thing it checks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { TARGETS, pathsFilter } from './check-deploy-watch-paths.mjs';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
const PROJECT_ID = 'e1334895-9fdc-4cab-9a3c-73416719c553';
const ENVIRONMENT_ID = '524fdbc8-c800-4c0a-bc0f-c962a0fb7ef4';

/* ── the decision, isolated from all I/O so it can be tested ──────────────── */

/**
 * Whether the live deployment is current with respect to the build closure.
 *
 * The invariant is containment, NOT equality. `serviceInstanceDeploy` is called
 * with `latestCommit: true`, so a deploy ships `main`'s head — which is usually
 * *newer* than the last commit that touched the watched paths. Requiring the two
 * to be equal would fire on every unrelated commit and train people to ignore it.
 *
 * What must hold is that the deployed commit CONTAINS the newest watched-path
 * commit. If it does not, a change to this service's build inputs was merged and
 * never reached production — which is the condition that is otherwise silent.
 */
/**
 * THREE verdicts, not two. `status` is `'ok' | 'stale' | 'unknown'`.
 *
 * `unknown` exists because the two-verdict version had to answer even when its
 * inputs were unanswerable, and a forced answer is wrong in whichever direction
 * it defaults. Both directions actually occurred in review:
 *
 *   - silent: reading a FAILED deployment as "what is running" and reporting OK;
 *   - loud-but-wrong-cause: an unresolvable commit reported as "the deploy
 *     workflow did not fire", which sends someone to fix a trigger that is fine.
 *
 * `unknown` is NOT a pass — it fails the job (exit 2, distinct from stale's 1) —
 * but it claims only "I could not observe the state", which is what a missing
 * observation is. This is the same distinction as the deploy workflow's own
 * lesson: a read that does not land is a missing observation, not a failed deploy.
 */
export function reconcile({ deployedCommit, requiredCommit, containment, liveness }) {
  // Liveness is decided before anything else: every later branch is a claim about
  // "the running deployment", so if we don't know which deployment is running,
  // no such claim is available. See `liveDeployment()` for the states.
  if (liveness && liveness.status !== 'live') {
    return { status: 'unknown', ok: false, reason: liveness.reason };
  }
  if (!deployedCommit) {
    return {
      status: 'unknown',
      ok: false,
      reason:
        'Railway reports no deployment for this service. Either the service was ' +
        'recreated (its id would have changed) or it has never deployed. Neither ' +
        'is a state this check can reason about — investigate before dismissing.',
    };
  }
  if (!requiredCommit) {
    // Nothing in history has touched the build closure, so there is nothing this
    // check can be stale relative to. Vacuously fine, and said out loud rather
    // than reported as a pass.
    return { status: 'ok', ok: true, reason: 'No commit on main has touched the watched paths yet.' };
  }
  if (containment === 'unresolvable') {
    // `git merge-base --is-ancestor` exits 1 for "not contained" and 128 for
    // "I cannot resolve that object". Collapsing them into `false` produced a
    // confident claim about the deploy workflow from what is really a git
    // problem: a rewritten history, a shallow clone, a deployment predating the
    // repo link, or a commit from a deleted branch.
    return {
      status: 'unknown',
      ok: false,
      reason:
        `Cannot resolve the deployed commit ${deployedCommit.slice(0, 8)} in this clone, so ` +
        `containment of ${requiredCommit.slice(0, 8)} is UNKNOWN — this is NOT a staleness ` +
        'claim and says nothing about whether the deploy fired. Likely: history rewritten, ' +
        'a shallow fetch (this job needs `fetch-depth: 0`), a deployment built before the ' +
        'repo link, or a commit from a deleted branch. Resolve the commit, then re-run.',
    };
  }
  if (containment === 'contained') {
    return {
      status: 'ok',
      ok: true,
      reason: `Deployed ${deployedCommit.slice(0, 8)} contains ${requiredCommit.slice(0, 8)}.`,
    };
  }
  return {
    status: 'stale',
    ok: false,
    reason:
      `STALE: commit ${requiredCommit.slice(0, 8)} touched this service's build inputs on ` +
      `main, but the running deployment (${deployedCommit.slice(0, 8)}) does not contain it. ` +
      'The deploy workflow did not fire, or fired and did not finish. Nothing else ' +
      'would have told you — that workflow cannot report its own non-firing.',
  };
}

/**
 * Which deployment is actually RUNNING — not which is newest.
 *
 * `deployments(first: 1)` is ordered by `createdAt` and includes deployments
 * that are not running. Measured on this very service: between 21:37:51Z and
 * 21:40:52Z on 2026-07-30 the newest deployment was FAILED at `065691bd`, while
 * the live one was an older deployment. A check keyed on "newest" reads the
 * FAILED commit as deployed and, if it happens to contain the required commit,
 * reports OK — the silent direction, in the check built to end silence.
 *
 * `status === 'SUCCESS'` is NOT the fix. Status is a lifecycle marker, not an
 * is-live flag: `e431dbdd` and `160ebb97` were each live in their turn and both
 * now read REMOVED. So this asks Railway for the pointer instead —
 * `serviceInstance.activeDeployments`, which returned exactly the running
 * deployment (1 entry, SUCCESS `680d018b`) when the deployment list's newest
 * happened to agree.
 *
 * Multiple actives (a rolling deploy) is a real state, so the invariant is that
 * EVERY active deployment must contain the required commit — traffic can be
 * served by any of them, and "one of the two is current" is not current.
 */
export function liveDeployment(actives) {
  if (!Array.isArray(actives) || actives.length === 0) {
    return {
      status: 'none',
      reason:
        'Railway reports NO active deployment for this service instance — nothing is ' +
        'running, so "is the running code current" has no answer. This is not a pass: ' +
        'the service may be torn down, sleeping, or never deployed. Check Railway ' +
        'before dismissing.',
    };
  }
  const withoutCommit = actives.filter((d) => !d.commit);
  if (withoutCommit.length) {
    return {
      status: 'no-commit',
      reason:
        `An active deployment (${withoutCommit[0].id?.slice(0, 8) ?? '?'}, ` +
        `${withoutCommit[0].status ?? '?'}) carries no \`meta.commitHash\`, so what it was ` +
        'built from is unknown. Image-based or manually-uploaded deploys look like this. ' +
        'Not a staleness claim — an unobservable one.',
    };
  }
  // The laggard decides: if any running deployment is behind, the service is not
  // fully current, and reporting the newest of them would hide that.
  return { status: 'live', deployments: actives };
}

/**
 * `git merge-base --is-ancestor` as three states.
 *
 * rc 0 contained · rc 1 NOT contained · anything else (128, ENOENT, ...) means
 * the question could not be asked. Verified live: 0, 1 and 128 respectively.
 */
export function classifyContainment(rc) {
  if (rc === 0) return 'contained';
  if (rc === 1) return 'not-contained';
  return 'unresolvable';
}

/**
 * A `paths:` glob as a git pathspec.
 *
 * `services/shared/**` and `services/shared/` select the same commits for
 * `git log`, and the directory form avoids depending on git's glob magic being
 * enabled. Exact-file entries pass through untouched.
 */
export function pathsToPathspecs(paths) {
  return paths.map((p) => (p.endsWith('/**') ? p.slice(0, -2) : p));
}

/* ── I/O ──────────────────────────────────────────────────────────────────── */

function railway(query, variables, token) {
  const body = JSON.stringify({ query, variables });
  const out = execFileSync(
    'curl',
    ['-sS', '--max-time', '30', RAILWAY_API,
     '-H', `Project-Access-Token: ${token}`,
     '-H', 'Content-Type: application/json',
     '--data', body],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);
  // Railway answers auth failures — and nonexistent ids — with HTTP 200 and an
  // errors array. Same trap the deploy workflow guards; same guard here.
  if (parsed.errors) {
    const messages = parsed.errors.map((e) => e.message).join('; ');
    throw new Error(
      `Railway returned a GraphQL error body: ${messages}. ` +
        'Note this is also what a WRONG serviceId returns, with a valid token — ' +
        'check the ids before assuming the credential is bad.'
    );
  }
  return parsed.data;
}

/** The RUNNING deployment(s). See `liveDeployment()` for why not `deployments(first: 1)`. */
function activeDeployments(serviceId, token) {
  const data = railway(
    'query($sid: String!, $eid: String!) { serviceInstance(serviceId: $sid, environmentId: $eid) ' +
      '{ activeDeployments { id status meta } } }',
    { sid: serviceId, eid: ENVIRONMENT_ID },
    token
  );
  const actives = data?.serviceInstance?.activeDeployments;
  if (!Array.isArray(actives)) {
    // Distinguish "no actives" (a state) from "the field is absent" (a broken
    // read). Returning [] for both would report a torn-down service on an API
    // change — loud, but about the wrong thing.
    throw new Error(
      'Railway returned no `serviceInstance.activeDeployments` array (got ' +
        `${JSON.stringify(actives)}). The query or the ids are wrong, or the schema moved — ` +
        'this is a failed read, not evidence about the service.'
    );
  }
  return actives.map((d) => ({ id: d.id, status: d.status, commit: d.meta?.commitHash ?? null }));
}

function newestCommitTouching(pathspecs) {
  const out = execFileSync(
    'git',
    ['log', '-1', '--format=%H', 'origin/main', '--', ...pathspecs],
    { encoding: 'utf8' }
  ).trim();
  return out || null;
}

/** Exit code of `git merge-base --is-ancestor`, or null if git could not run at all. */
function isAncestorExitCode(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return 0;
  } catch (err) {
    // `status` is the process exit code (1 = not contained, 128 = bad object).
    // A spawn failure (git missing) has no status; that is unresolvable too, and
    // must not be silently folded into "not contained".
    return typeof err?.status === 'number' ? err.status : null;
  }
}

function main() {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error('::error::RAILWAY_TOKEN is not set. This check cannot read the live deployment.');
    process.exit(1);
  }

  const target = TARGETS[0];
  const { paths, problems } = pathsFilter(readFileSync(target.workflow, 'utf8'));
  if (problems.length || !paths?.length) {
    console.error(
      `::error::Could not read a \`paths:\` filter from ${target.workflow}: ` +
        `${problems.join('; ') || 'no entries'}. This check derives what to watch from that ` +
        'filter, so it cannot run without it — and a silent pass here would be the ' +
        'same silence it exists to detect.'
    );
    process.exit(1);
  }

  const serviceId = process.env.RAILWAY_SERVICE_ID;
  if (!serviceId) {
    console.error('::error::RAILWAY_SERVICE_ID is not set.');
    process.exit(1);
  }

  const actives = activeDeployments(serviceId, token);
  const requiredCommit = newestCommitTouching(pathsToPathspecs(paths));
  const liveness = liveDeployment(actives);

  console.log(`watched paths:      ${paths.join(', ')}`);
  console.log(`newest such commit: ${requiredCommit ?? '<none>'}`);
  for (const d of actives) {
    console.log(`active deployment:  ${d.id?.slice(0, 8) ?? '?'} (${d.status ?? '-'}) commit ${d.commit ?? '<none>'}`);
  }
  if (!actives.length) console.log('active deployment:  <none>');

  // Every RUNNING deployment must contain the required commit; the laggard
  // decides. With one active this is the ordinary case, and a rolling deploy
  // where only the newer replica is current is genuinely not-yet-current.
  const verdicts =
    liveness.status === 'live' && requiredCommit
      ? liveness.deployments.map((d) =>
          reconcile({
            deployedCommit: d.commit,
            requiredCommit,
            containment: classifyContainment(isAncestorExitCode(requiredCommit, d.commit)),
          })
        )
      : [reconcile({ deployedCommit: actives[0]?.commit ?? null, requiredCommit, liveness })];

  // Worst verdict wins, and `unknown` outranks `ok` — a missing observation must
  // never be outvoted by a replica that happened to be readable.
  const verdict =
    verdicts.find((v) => v.status === 'stale') ??
    verdicts.find((v) => v.status === 'unknown') ??
    verdicts[0];

  if (verdict.status === 'ok') {
    console.log(`✓ ${verdict.reason}`);
    return;
  }
  console.error(`::error::${verdict.reason}`);
  // Exit 2 for `unknown` so "I could not observe this" is distinguishable from
  // "the service is stale" by anything reading the exit code, not just by a human
  // reading the log. Both are loud; only one is a claim about the deploy.
  process.exit(verdict.status === 'unknown' ? 2 : 1);
}

const invokedDirectly = process.argv[1]?.endsWith('check-registry-funpay-deployed.mjs');
if (invokedDirectly) main();
