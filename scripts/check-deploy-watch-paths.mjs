#!/usr/bin/env node
/**
 * Guard: the `paths:` filter on a CI deploy workflow must cover everything the
 * service's Docker build actually reads.
 *
 * WHY THIS EXISTS
 *
 * `registry-service-funpay` has no Railway deployment trigger, so
 * `.github/workflows/deploy-registry-funpay.yml` deploys it instead. Its
 * `paths:` filter decides what counts as "this service changed". Getting that
 * filter too narrow fails in the worst possible direction: a merged fix to an
 * uncovered path produces no deploy, no failed run, no email, and nothing in
 * the Railway UI — the service just keeps serving its previous container. That
 * is precisely the six-day staleness the workflow was built to end, rebuilt
 * inside the fix.
 *
 * The filter is hand-maintained and the build's real inputs are not, so they
 * drift. This recomputes the inputs from the Dockerfile and fails if the
 * filter has fallen behind.
 *
 * WHY THE COPY SET AND NOT A MANIFEST
 *
 * This service is built from a Dockerfile with the repo root as context. The
 * ground truth for "what goes into the image" is therefore the `COPY` set, not
 * any package manifest: `services/registry-service/index.js` reaches
 * `../shared/registry/pool` by relative path, and no package.json anywhere in
 * this repo mentions `services/shared`. A manifest-derived check would have
 * declared the filter fully covered while missing the exact file (#556,
 * `services/shared/registry/pool.js`) whose absence caused a production
 * incident.
 *
 * A sibling repo runs the same guard deriving the closure from a pnpm
 * workspace graph, which is correct there because its services are
 * NIXPACKS-built from `pnpm --filter`. Same idea, different derivation. Do not
 * port that one here or this one there.
 *
 * WHY THE PREMISE IS ASSERTED, NOT DOCUMENTED
 *
 * Everything above holds only while this service stays Dockerfile-built from
 * the repo root. If the Dockerfile disappears, or a Railway config file
 * appears (`railwayConfigFile` is null on service instance
 * `0cf12987-4aba-4b20-942f-c8436d956723` as of 2026-08-06, which is the only
 * reason the Dockerfile is authoritative), or a `COPY` source stops resolving
 * from the repo root, then this check would be comparing the filter against a
 * build that no longer exists — and it would pass. A green check on a false
 * premise is worse than no check, because it is read as coverage. So each
 * premise below fails the job loudly instead.
 *
 * THE PREMISE THIS FILE CANNOT SEE
 *
 * One link in that chain is invisible from the repo, and the obvious signal for
 * it is actively misleading: the service instance reports `builder: RAILPACK`.
 * It is Dockerfile-built anyway, purely because the Railway service variable
 * `RAILWAY_DOCKERFILE_PATH` overrides the builder. Delete that one variable and
 * the build silently becomes a Railpack build with entirely different inputs,
 * while this check keeps passing — the Dockerfile is still on disk and
 * `railwayConfigFile` is still null. Nothing here can detect it.
 *
 * So that half is asserted where the credentials are: the
 * "Confirm Railway still builds this service the way the paths filter assumes"
 * step in deploy-registry-funpay.yml checks `RAILWAY_DOCKERFILE_PATH`,
 * `railwayConfigFile` and `rootDirectory` against the live API before every
 * deploy, and fails closed. The two halves are one guard. If you change either,
 * read the other.
 *
 * ONE DIRECTION ONLY
 *
 * This asserts filter ⊇ build inputs. It deliberately does not flag a `paths:`
 * entry that no `COPY` needs: an extra entry causes a redundant deploy, which
 * is noisy and visible. A missing one causes silence. Only the silent
 * direction is a failure.
 *
 * RUN
 *
 *   node scripts/check-deploy-watch-paths.mjs
 *
 * Both file paths can be overridden, from the repo root, so the check can be
 * negative-tested against a doctored copy without touching the real files:
 *
 *   cp services/registry-service/Dockerfile /tmp/Dockerfile.bad
 *   echo 'COPY services/underwriting-service/ ./x/' >> /tmp/Dockerfile.bad
 *   node scripts/check-deploy-watch-paths.mjs \
 *     /tmp/Dockerfile.bad .github/workflows/deploy-registry-funpay.yml   # must exit 1
 *
 * No dependencies, so CI can run it before any install.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Services deployed by a CI workflow rather than a Railway trigger. One entry
 * today; add a row when a second service gets the same treatment.
 */
const TARGETS = [
  {
    service: 'registry-service-funpay',
    dockerfile: 'services/registry-service/Dockerfile',
    workflow: '.github/workflows/deploy-registry-funpay.yml',
    // The Railway service instance whose `railwayConfigFile` must stay null for
    // the Dockerfile to be the authoritative build definition.
    // NOTE: the service id is deliberately NOT here. It is read from the
    // workflow's `env: RAILWAY_SERVICE_ID` at check time — see `checkTarget`.
    // A second copy in this file had exactly one consumer, a message string,
    // and nothing ever compared it: on the day the service is recreated the
    // workflow's copy breaks deploys loudly while this one rots in silence,
    // and the silent one is the half that names which instance to go inspect.
    // Directories a Railway config file would live in for this service. Its
    // appearance means the build definition may have moved out of the
    // Dockerfile — see the premise note above.
    configDirs: ['.', 'services/registry-service'],
  },
];

/** A Railway config file in any of these forms takes over the build definition. */
const RAILWAY_CONFIG_FILES = ['railway.toml', 'railway.json', 'railway.jsonc'];

const GLOB = /[*?[\]]/;

/**
 * Dockerfile instructions, one per logical line: comments dropped (including
 * comment lines sitting inside a continuation, which Docker also drops) and
 * backslash continuations joined.
 */
function logicalLines(text) {
  const out = [];
  let acc = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    const trimmed = line.replace(/\s+$/, '');
    const continues = trimmed.endsWith('\\');
    const body = continues ? trimmed.slice(0, -1) : trimmed;
    acc = acc === null ? body : `${acc} ${body.trim()}`;
    if (!continues) {
      if (acc.trim()) out.push(acc.trim());
      acc = null;
    }
  }
  if (acc !== null && acc.trim()) out.push(acc.trim());
  return out;
}

/**
 * Build-context sources of every COPY/ADD in a Dockerfile.
 *
 * An instruction this cannot parse is reported as a problem rather than
 * skipped: a silently ignored COPY is an uncovered path that reports covered,
 * which is the failure this whole file exists to prevent.
 */
function copySources(text) {
  const sources = [];
  const problems = [];

  for (const line of logicalLines(text)) {
    const match = line.match(/^(COPY|ADD)\s+(.+)$/i);
    if (!match) continue;
    const [, verb, tail] = match;

    // Heredoc form writes inline content — it reads nothing from the context.
    if (/<<-?\s*['"]?[A-Za-z_]/.test(tail)) continue;

    const flags = [];
    const rest = tail
      .replace(/(^|\s)(--[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S*))?)/g, (_m, _sp, flag) => {
        flags.push(flag);
        return ' ';
      })
      .trim();

    // --from=<stage|image> copies from a previous stage or another image, not
    // from the build context, so it needs no path coverage.
    if (flags.some((f) => /^--from=/i.test(f))) continue;

    let args;
    if (rest.startsWith('[')) {
      try {
        args = JSON.parse(rest);
      } catch {
        problems.push(`could not parse the JSON form of: ${line}`);
        continue;
      }
    } else {
      args = rest.split(/\s+/).filter(Boolean);
    }

    if (!Array.isArray(args) || args.length < 2) {
      problems.push(`could not read sources and destination from: ${line}`);
      continue;
    }

    for (const src of args.slice(0, -1)) sources.push({ src, verb, line });
  }

  return { sources, problems };
}

/**
 * The longest leading run of literal path segments, i.e. the narrowest thing
 * on disk that can contain everything the source matches. `package*.json`
 * reduces to its directory. This over-requires slightly for wildcards, which
 * is the safe direction: it can demand coverage the build does not strictly
 * need, never the reverse.
 */
function literalPrefix(src) {
  const cleaned = src.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!GLOB.test(cleaned)) return cleaned;
  const kept = [];
  for (const segment of cleaned.split('/')) {
    if (GLOB.test(segment)) break;
    kept.push(segment);
  }
  return kept.join('/');
}

/**
 * The `paths:` list of the workflow's `push:` trigger.
 *
 * A targeted extraction rather than a YAML dependency, so this stays runnable
 * before `npm ci`. It is strict about what it will accept: anything it is not
 * certain it has read correctly is reported, never guessed at.
 */
/**
 * The value of a top-level `env:` key in a workflow, or null if absent.
 *
 * Same deliberately-small parser as `pathsFilter` below, for the same reason:
 * this check runs before `npm ci` so it can fail in seconds, which rules out a
 * YAML dependency. It reads one scalar under one block and gives up loudly on
 * anything it does not recognize, rather than guessing.
 */
function workflowEnvValue(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^env:\s*$/.test(l));
  if (start < 0) return null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // Dedent to column 0 ends the top-level env block.
    if (!/^\s/.test(line)) break;
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match && match[1] === key) {
      return match[2].trim().replace(/^['"]|['"]$/g, '') || null;
    }
  }
  return null;
}

function pathsFilter(yaml) {
  const lines = yaml.split('\n');
  const problems = [];

  if (!/^\s*push:\s*$/m.test(yaml)) {
    problems.push(
      'the workflow has no `push:` trigger, so there is no paths filter to guard. ' +
        'If the deploy moved to another event, re-derive this check against it.'
    );
    return { paths: null, problems };
  }

  if (/^\s*paths-ignore:/m.test(yaml)) {
    problems.push(
      '`paths-ignore:` is present. This check models an allow-list (`paths:`) and cannot ' +
        'reason about an exclusion list — its result would be meaningless. Rewrite the ' +
        'filter as `paths:` or rewrite this check.'
    );
    return { paths: null, problems };
  }

  const starts = lines.map((l, i) => (/^\s*paths:\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length > 1) {
    problems.push(
      `found ${starts.length} \`paths:\` blocks; this check cannot tell which one filters the ` +
        'deploy. Split the workflow or teach this check which block to read.'
    );
    return { paths: null, problems };
  }

  // No paths block at all means every push to the branch deploys. Noisy, but it
  // can never silently pin the service to an old container, so it is not a
  // failure here.
  if (starts.length === 0) return { paths: null, problems };

  const start = starts[0];
  const indent = lines[start].match(/^(\s*)/)[1].length;
  const paths = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const currentIndent = line.match(/^(\s*)/)[1].length;
    if (currentIndent <= indent) break;
    const item = line.trim().match(/^-\s*(.+?)\s*$/);
    if (!item) {
      problems.push(`unreadable entry in the \`paths:\` block: ${line.trim()}`);
      return { paths: null, problems };
    }
    paths.push(item[1].replace(/^['"]|['"]$/g, ''));
  }

  return { paths, problems };
}

/**
 * GitHub `paths:` semantics, restricted to the two forms we accept.
 *
 * A bare directory (`services/shared`) matches a *file* of that name, not the
 * tree under it, so only `services/shared/**` counts as covering a directory.
 * Any other pattern shape is treated as not covering — unrecognised means
 * unproven, and unproven has to fail.
 */
function covered(patterns, path, isDir) {
  return patterns.some((pattern) => {
    if (pattern === '**') return true;
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3);
      return path === base || path.startsWith(`${base}/`);
    }
    return !isDir && pattern === path;
  });
}

function checkTarget(target, dockerfilePath, workflowPath) {
  const problems = [];
  const missing = [];

  if (!existsSync(dockerfilePath)) {
    problems.push(
      `${dockerfilePath} does not exist. This check derives the deploy filter's required ` +
        'coverage from that Dockerfile\'s COPY set; with no Dockerfile it has nothing to ' +
        'compare and would pass on a stale assumption. If the service stopped being ' +
        'Dockerfile-built, re-derive this check from whatever now defines the build.'
    );
  }
  if (!existsSync(workflowPath)) {
    problems.push(
      `${workflowPath} does not exist. If the deploy workflow was deleted because a Railway ` +
        'deployment trigger was finally added, delete this check with it — otherwise the ' +
        'service is deploying from something neither this check nor the workflow describes.'
    );
  }
  if (problems.length) return { problems, missing, paths: null };

  // `EXPECTED_DOCKERFILE` in the workflow and `target.dockerfile` here are the
  // same string in two files. Neither drift direction is silent — a stale value
  // here fails the existsSync above, and a stale one there fails the deploy
  // workflow's own build-premise guard — but that is two indirect failures
  // where one direct message will do, and "these must match" living only in a
  // comment is the arrangement that cost us the instance watchPatterns.
  const workflowYaml = readFileSync(workflowPath, 'utf8');

  // The one definition of the service id lives in the workflow, because that is
  // where a wrong id fails loudly — the deploy stops. Reading it from there
  // rather than keeping a copy here means there is no invariant to maintain and
  // no silent half to rot.
  const serviceInstanceId = workflowEnvValue(workflowYaml, 'RAILWAY_SERVICE_ID');
  if (serviceInstanceId === null) {
    problems.push(
      `${workflowPath} declares no \`RAILWAY_SERVICE_ID\`. This check reports which Railway ` +
        'service instance to inspect when the build premise breaks, and takes that id from ' +
        'the workflow so the two cannot disagree. With it absent there is no id to report.'
    );
  }

  const declared = workflowEnvValue(workflowYaml, 'EXPECTED_DOCKERFILE');
  if (declared === null) {
    problems.push(
      `${workflowPath} declares no \`EXPECTED_DOCKERFILE\`. The deploy workflow asserts ` +
        'against that value that Railway still builds this service from the Dockerfile ' +
        'this check reads. Without it, nothing checks the premise at deploy time.'
    );
  } else if (declared !== target.dockerfile) {
    problems.push(
      `${workflowPath} declares \`EXPECTED_DOCKERFILE: ${declared}\`, but this check derives ` +
        `coverage from ${target.dockerfile}. One of the two moved and the other did not, so ` +
        'the deploy guard and this check are describing different builds. Make them equal.'
    );
  }
  if (problems.length) return { problems, missing, paths: null };

  for (const dir of target.configDirs) {
    for (const name of RAILWAY_CONFIG_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        problems.push(
          `${candidate} exists. The Dockerfile is only authoritative because ` +
            `\`railwayConfigFile\` is null on service instance ${serviceInstanceId}. ` +
            'A Railway config file can redefine the builder and carry its own watch ' +
            'patterns, so the COPY set would no longer be the whole story. Confirm what ' +
            'the service actually builds from and update this check.'
        );
      }
    }
  }

  const { sources, problems: copyProblems } = copySources(readFileSync(dockerfilePath, 'utf8'));
  problems.push(...copyProblems);

  if (!sources.length) {
    problems.push(
      `${dockerfilePath} has no COPY/ADD reading the build context. A build that copies ` +
        'nothing is not the build this check was written against.'
    );
  }

  // Required inputs: every COPY source, plus the two files that define the
  // context itself. Changing the Dockerfile changes the image; changing
  // .dockerignore changes what the COPY lines actually pick up.
  const required = new Map();
  const requireInput = (path, why) => {
    if (!path) {
      problems.push(
        `${why} copies the entire build context, which no paths filter can narrow. Either ` +
          'narrow the COPY or drop the filter and deploy on every push.'
      );
      return;
    }
    if (!existsSync(path)) {
      problems.push(
        `${why} resolves to "${path}", which does not exist at the repo root. Either the ` +
          'path is stale or the build context is no longer the repo root (Railway root ' +
          'directory changed) — in both cases this check is measuring the wrong thing.'
      );
      return;
    }
    if (!required.has(path)) required.set(path, { isDir: statSync(path).isDirectory(), why });
  };

  for (const { src, line } of sources) {
    requireInput(literalPrefix(src), `\`${line}\``);
  }
  // target.dockerfile, not dockerfilePath: under the negative-test override the
  // parsed file is a doctored copy living outside the repo, and that copy is not
  // a build input of anything. The real service's Dockerfile is.
  requireInput(target.dockerfile, 'the Dockerfile itself');
  if (existsSync('.dockerignore')) requireInput('.dockerignore', 'the build context .dockerignore');

  const { paths, problems: yamlProblems } = pathsFilter(readFileSync(workflowPath, 'utf8'));
  problems.push(...yamlProblems);
  if (problems.length) return { problems, missing, paths };

  if (paths === null) {
    console.log(
      `- ${target.service}: no \`paths:\` filter — every push to the branch deploys. ` +
        'Noisy, but nothing can be silently missed, so not a failure.'
    );
    return { problems, missing, paths };
  }

  for (const [path, { isDir, why }] of required) {
    if (!covered(paths, path, isDir)) missing.push({ path, isDir, why });
  }

  return { problems, missing, paths };
}

const WORKFLOW_DIR = '.github/workflows';

/**
 * Every workflow that deploys a Railway service, found rather than declared.
 *
 * `TARGETS` is hand-maintained and one row long. Nothing made it agree with
 * reality, so the day a second CI-deployed service is added this check would go
 * green while saying nothing whatsoever about it — and print "Every CI-deployed
 * service watches everything its build reads" as it did. Under-coverage wearing
 * full coverage's output, which is the same silent direction as a too-narrow
 * `paths:` filter, one level up.
 *
 * Matched on the mutation name rather than the endpoint: a workflow that merely
 * reads Railway (`sync-registry-funpay-secret.yml` upserts variables) is not
 * deploying from a build context and has no `paths:` closure to check.
 */
function railwayDeployWorkflows() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(WORKFLOW_DIR, name))
    .filter((path) => readFileSync(path, 'utf8').includes('serviceInstanceDeploy'));
}

const [argDockerfile, argWorkflow] = process.argv.slice(2);
const targets =
  argDockerfile && argWorkflow
    ? [{ ...TARGETS[0], parseDockerfile: argDockerfile, workflow: argWorkflow }]
    : TARGETS;

let failed = false;

// Run before the per-target loop: if TARGETS does not cover everything that
// deploys, no per-target result can be trusted to mean what it says.
// Skipped under the two-argument negative-test override, where `targets` is
// deliberately a fixture rather than this repo's real deploy set.
if (!argDockerfile) {
  const uncovered = railwayDeployWorkflows().filter(
    (path) => !TARGETS.some((t) => t.workflow === path)
  );
  if (uncovered.length) {
    failed = true;
    console.error(
      '\nthis check does not cover every workflow that deploys a Railway service.\n\n' +
        'TARGETS is hand-maintained, so a new deploy workflow is invisible to it — the check ' +
        'would keep printing a clean result while saying nothing at all about the new service, ' +
        'including whether its `paths:` filter covers its build context.\n'
    );
    for (const path of uncovered) {
      console.error(`  uncovered: ${path}`);
      console.error('    it calls `serviceInstanceDeploy` but has no TARGETS entry');
      console.error(
        '    fix: add a { service, dockerfile, workflow, configDirs } row to TARGETS in ' +
          'scripts/check-deploy-watch-paths.mjs\n'
      );
    }
  }
}

for (const target of targets) {
  const { problems, missing, paths } = checkTarget(
    target,
    target.parseDockerfile ?? target.dockerfile,
    target.workflow
  );

  if (problems.length) {
    failed = true;
    console.error(`\n${target.service}: this check's premise no longer holds, so its result `
      + 'would be misleading. Not reporting coverage.\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    continue;
  }

  if (missing.length) {
    failed = true;
    console.error(
      `\n${target.service}: the deploy filter in ${target.workflow} does not cover everything ` +
        `${target.dockerfile} builds from.\n\n` +
        'A push touching an uncovered path will NOT redeploy the service. There will be no ' +
        'failed run and no alert, because nothing will run at all — the service will keep ' +
        'serving its previous container.\n'
    );
    for (const { path, isDir, why } of missing) {
      console.error(`  uncovered: ${path}${isDir ? '/' : ''}`);
      console.error(`    required by ${why}`);
      console.error(
        `    fix: add "${isDir ? `${path}/**` : path}" to the \`paths:\` list in ${target.workflow}\n`
      );
    }
    continue;
  }

  if (paths !== null) {
    console.log(
      `✓ ${target.service}: ${paths.length} paths entries cover every build input of ${target.dockerfile}`
    );
  }
}

if (failed) process.exit(1);
console.log('\nEvery CI-deployed service watches everything its build reads.');
