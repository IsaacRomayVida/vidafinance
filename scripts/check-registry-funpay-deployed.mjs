/**
 * Does the running service actually contain the code that should have deployed?
 *
 * `deploy-registry-funpay.yml` deploys `registry-service-funpay` on pushes to
 * `main` that touch its `paths:` set. That workflow cannot detect its own
 * non-firing: if the trigger is dropped, there is no failed run and no alert —
 * "nothing ran at all", which is the exact sentence in its own header and the
 * six-day staleness it was built to end.
 *
 * It happened immediately. `680d018b` touched
 * `.github/workflows/deploy-registry-funpay.yml` — a path in its own filter — on
 * a push to `main`, and drew **zero** push runs during the 2026-08-06 webhook
 * throttle. What reached production was a hand-run `workflow_dispatch`, which
 * masked the miss: the service was current, so nothing looked wrong, and the
 * auto-trigger had still never fired in production.
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
export function reconcile({ deployedCommit, requiredCommit, deployedContainsRequired }) {
  if (!deployedCommit) {
    return {
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
    return { ok: true, reason: 'No commit on main has touched the watched paths yet.' };
  }
  if (deployedContainsRequired) {
    return {
      ok: true,
      reason: `Deployed ${deployedCommit.slice(0, 8)} contains ${requiredCommit.slice(0, 8)}.`,
    };
  }
  return {
    ok: false,
    reason:
      `STALE: commit ${requiredCommit.slice(0, 8)} touched this service's build inputs on ` +
      `main, but the running deployment (${deployedCommit.slice(0, 8)}) does not contain it. ` +
      'The deploy workflow did not fire, or fired and did not finish. Nothing else ' +
      'would have told you — that workflow cannot report its own non-firing.',
  };
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

function newestDeployedCommit(serviceId, token) {
  const data = railway(
    'query($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status meta } } } }',
    { input: { projectId: PROJECT_ID, serviceId, environmentId: ENVIRONMENT_ID } },
    token
  );
  const node = data?.deployments?.edges?.[0]?.node;
  return node ? { id: node.id, status: node.status, commit: node.meta?.commitHash ?? null } : null;
}

function newestCommitTouching(pathspecs) {
  const out = execFileSync(
    'git',
    ['log', '-1', '--format=%H', 'origin/main', '--', ...pathspecs],
    { encoding: 'utf8' }
  ).trim();
  return out || null;
}

function contains(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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

  const deployment = newestDeployedCommit(serviceId, token);
  const requiredCommit = newestCommitTouching(pathsToPathspecs(paths));
  const deployedCommit = deployment?.commit ?? null;

  const verdict = reconcile({
    deployedCommit,
    requiredCommit,
    deployedContainsRequired:
      deployedCommit && requiredCommit ? contains(requiredCommit, deployedCommit) : false,
  });

  console.log(`watched paths:     ${paths.join(', ')}`);
  console.log(`newest such commit: ${requiredCommit ?? '<none>'}`);
  console.log(`live deployment:    ${deployment?.id?.slice(0, 8) ?? '<none>'} (${deployment?.status ?? '-'}) commit ${deployedCommit ?? '<none>'}`);

  if (!verdict.ok) {
    console.error(`::error::${verdict.reason}`);
    process.exit(1);
  }
  console.log(`✓ ${verdict.reason}`);
}

const invokedDirectly = process.argv[1]?.endsWith('check-registry-funpay-deployed.mjs');
if (invokedDirectly) main();
