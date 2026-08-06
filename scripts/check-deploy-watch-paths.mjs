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
import { readFileSync, existsSync, statSync } from 'node:fs';
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
    serviceInstanceId: '0cf12987-4aba-4b20-942f-c8436d956723',
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

  for (const dir of target.configDirs) {
    for (const name of RAILWAY_CONFIG_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        problems.push(
          `${candidate} exists. The Dockerfile is only authoritative because ` +
            `\`railwayConfigFile\` is null on service instance ${target.serviceInstanceId}. ` +
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

const [argDockerfile, argWorkflow] = process.argv.slice(2);
const targets =
  argDockerfile && argWorkflow
    ? [{ ...TARGETS[0], parseDockerfile: argDockerfile, workflow: argWorkflow }]
    : TARGETS;

let failed = false;

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
