/**
 * Tests for check-deploy-watch-paths.mjs — the drift check that keeps the
 * deploy `paths:` filter covering the Docker build context.
 *
 * A drift check that has never failed is a check nobody has verified. This one
 * guards against a silent condition — too narrow a filter means a merged fix
 * produces no deploy, no failed run and no alert — so if it ever stops firing,
 * nothing tells us. The only way to know it still works is to hand it a repo
 * that should fail and watch it fail.
 *
 * Each case builds a throwaway repo under the OS temp dir and runs the real
 * script with its cwd pointed there. Nothing is stubbed and the script is not
 * modified: its paths are repo-relative, so a fixture tree is a complete
 * substitute for the real one. That matters — a test that reimplemented the
 * COPY parser would pass while the parser rotted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-deploy-watch-paths.mjs');

/** The Dockerfile the real service builds from, reduced to its COPY set. */
const GOOD_DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY services/registry-service/package*.json ./
RUN npm ci --only=production
COPY services/shared/ ./services/shared/
COPY services/registry-service/ ./services/registry-service/
CMD ["node", "index.js"]
`;

const GOOD_WORKFLOW = `name: Deploy registry-service-funpay (Railway)
on:
  push:
    branches: [main]
    paths:
      - 'services/registry-service/**'
      - 'services/shared/**'
      - '.dockerignore'
      - '.github/workflows/deploy-registry-funpay.yml'
  workflow_dispatch: {}
env:
  RAILWAY_SERVICE_ID: 0cf12987-4aba-4b20-942f-c8436d956723
  EXPECTED_DOCKERFILE: services/registry-service/Dockerfile
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
`;

/** The underwriting service: same Dockerfile shape, deployed by hand only. */
const UW_DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY services/underwriting-service/package*.json ./
RUN npm ci --only=production
COPY services/shared/ ./services/shared/
COPY services/underwriting-service/ ./services/underwriting-service/
CMD ["node", "index.js"]
`;

const UW_WORKFLOW = `name: Deploy underwriting-service (Railway)
# A push trigger is a separate decision; see docs/runbooks/deploy.md.
# on:
#   push:
on:
  workflow_dispatch: {}
env:
  RAILWAY_SERVICE_NAME: underwriting-service
  EXPECTED_DOCKERFILE: services/underwriting-service/Dockerfile
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo serviceInstanceDeploy
`;

/**
 * A fixture repo laid out at the paths TARGETS hardcodes.
 *
 * `files` overrides or adds to the baseline; a value of `null` deletes, which is
 * how the missing-Dockerfile case is expressed.
 */
function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'watchpaths-'));
  const baseline = {
    'services/registry-service/Dockerfile': GOOD_DOCKERFILE,
    'services/registry-service/index.js': '// service entrypoint\n',
    'services/registry-service/package.json': '{"name":"registry-service"}\n',
    'services/shared/registry/pool.js': '// shared pool\n',
    '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW,
    'services/underwriting-service/Dockerfile': UW_DOCKERFILE,
    'services/underwriting-service/index.js': '// service entrypoint\n',
    'services/underwriting-service/package.json': '{"name":"underwriting-service"}\n',
    '.github/workflows/deploy-underwriting.yml': UW_WORKFLOW,
    '.dockerignore': 'node_modules\n',
  };

  for (const [rel, body] of Object.entries({ ...baseline, ...files })) {
    if (body === null) continue;
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/**
 * Runs the real script against a fixture. Never throws — the exit code is the
 * assertion.
 *
 * Goes through a shell with `2>&1` so stdout and stderr interleave in real
 * time, exactly as they do in a terminal or a CI log. Capturing the two streams
 * separately and concatenating them looks equivalent and is not: it re-orders
 * the output by stream instead of by time, which silently destroys any
 * assertion about what a run says LAST. The green-tick-on-failure test below
 * was inert for precisely that reason until this was fixed — it passed against
 * the bug it was written to catch.
 */
function run(root) {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} 2>&1`;
  try {
    const merged = execFileSync('/bin/sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: merged };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withFixture(files, assertions) {
  const root = fixture(files);
  try {
    assertions(run(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-deploy-watch-paths', () => {
  it('passes when the paths filter covers every COPY source', () => {
    // The positive control. Without it, every assertion below could be
    // satisfied by a script that fails unconditionally.
    withFixture({}, ({ code, out }) => {
      assert.equal(code, 0, `expected pass, got:\n${out}`);
      assert.match(out, /cover every build input/);
    });
  });

  it('FAILS, and names the path, when a COPY source is not covered by the filter', () => {
    // The case the check exists for. `services/somethingelse/` is a real build
    // input that no `paths:` entry matches, so a commit touching only that
    // directory would merge and deploy nothing, with no failed run and no
    // alert — the six-day staleness this whole workflow was built to end.
    withFixture(
      {
        'services/registry-service/Dockerfile':
          GOOD_DOCKERFILE + 'COPY services/somethingelse/ ./services/somethingelse/\n',
        'services/somethingelse/probe.js': '// an uncovered build input\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /does not cover everything/);
        assert.match(out, /uncovered: services\/somethingelse\//);
        // The message has to carry the fix, not just the complaint.
        assert.match(out, /add "services\/somethingelse\/\*\*"/);
      }
    );
  });

  it('FAILS when the filter is narrowed so services/shared stops being covered', () => {
    // The six-day incident, reproduced. Nothing about the Dockerfile changes —
    // the filter is what shrinks. #556 edited services/shared/registry/pool.js,
    // it merged, and under a filter like this one it deployed nothing: no failed
    // run, no alert, the service quietly serving its previous container for six
    // days while carrying the bug that fix closed.
    //
    // Distinct from the uncovered-COPY case above and worth both: that one is a
    // build input arriving, this one is coverage leaving. The filter is the side
    // a person edits by hand, so it is the side that shrinks by accident.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          "      - 'services/shared/**'\n",
          ''
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /uncovered: services\/shared\//);
        assert.match(out, /required by `COPY services\/shared\//);
      }
    );
  });

  it('FAILS when the workflow and this script name different Dockerfiles', () => {
    // The two hand-maintained copies of one path. Neither drift direction was
    // silent before this assertion existed, but both were indirect; this turns
    // them into one message that says which two things disagree.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          'EXPECTED_DOCKERFILE: services/registry-service/Dockerfile',
          'EXPECTED_DOCKERFILE: services/registry-service/Dockerfile.new'
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /declares `EXPECTED_DOCKERFILE: services\/registry-service\/Dockerfile\.new`/);
        assert.match(out, /describing different builds/);
      }
    );
  });

  it('FAILS when the workflow declares no EXPECTED_DOCKERFILE at all', () => {
    // Deleting the variable would otherwise leave the deploy-time build-premise
    // guard comparing against an empty string, which nothing would report.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          '  EXPECTED_DOCKERFILE: services/registry-service/Dockerfile\n',
          ''
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /declares no `EXPECTED_DOCKERFILE`/);
      }
    );
  });

  it('FAILS when the workflow declares no RAILWAY_SERVICE_ID', () => {
    // The id has one definition — the workflow's `env:` block — because that is
    // where a wrong value fails loudly. This check reports which instance to go
    // and inspect, so with the id absent it has nothing to report.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          '  RAILWAY_SERVICE_ID: 0cf12987-4aba-4b20-942f-c8436d956723\n',
          ''
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /declares no `RAILWAY_SERVICE_ID`/);
      }
    );
  });

  it('reports the service instance id it read from the workflow, not a copy of its own', () => {
    // The point of deleting the second copy: prove the value actually flows from
    // the workflow. A distinctive id in the fixture must appear verbatim in the
    // message, which it cannot do if the script is quoting a hardcoded constant.
    //
    // A `railway.toml` is what surfaces that message — its presence means the
    // Dockerfile may no longer be the authoritative build definition.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          '0cf12987-4aba-4b20-942f-c8436d956723',
          'deadbeef-1111-2222-3333-444444444444'
        ),
        'railway.toml': '[build]\nbuilder = "NIXPACKS"\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /service instance deadbeef-1111-2222-3333-444444444444/);
        assert.doesNotMatch(out, /0cf12987/);
      }
    );
  });

  it('FAILS when a second workflow deploys a Railway service and TARGETS does not know', () => {
    // TARGETS is hand-maintained and one row long. Without this, adding a second
    // CI-deployed service leaves the check green and silent about it — while
    // still printing "Every CI-deployed service watches everything its build
    // reads". Under-coverage wearing full coverage's output, which is the
    // too-narrow `paths:` filter one level up.
    withFixture(
      {
        '.github/workflows/deploy-second-service.yml':
          'name: Deploy some other service\n' +
          'on: { workflow_dispatch: {} }\n' +
          'jobs:\n' +
          '  deploy:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      - run: |\n' +
          '          curl "$RAILWAY_API" --data \'{"query":"mutation { serviceInstanceDeploy(serviceId: \\"x\\", environmentId: \\"y\\", latestCommit: true) }"}\'\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /does not cover every workflow that deploys a Railway service/);
        assert.match(out, /uncovered: \.github\/workflows\/deploy-second-service\.yml/);
        assert.match(out, /add a \{ service, dockerfile, workflow, configDirs \} row/);
      }
    );
  });

  it('never signs off with a green tick on a run that fails', () => {
    // The exit code was always correct here; the log tail was not. On an
    // uncovered-workflow failure the per-target ✓ printed after the error
    // block, so the LAST line of a failing run read as success — and the last
    // line is what someone scanning a CI log actually sees.
    //
    // Asserted on the tail specifically, not just on absence anywhere: this is
    // a fact about ordering, and a test that only checked "no ✓ in the output"
    // would still pass if the tick moved somewhere else equally misleading.
    withFixture(
      {
        '.github/workflows/deploy-second-service.yml':
          'name: Deploy some other service\n' +
          'on: { workflow_dispatch: {} }\n' +
          'jobs:\n' +
          '  deploy:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      - run: echo serviceInstanceDeploy\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        const lastLine = out.split('\n').filter((l) => l.trim()).pop();
        assert.doesNotMatch(lastLine ?? '', /✓/, `failing run ended on: ${lastLine}`);
        assert.doesNotMatch(out, /watches everything its build reads/);
      }
    );
  });

  it('does not flag a workflow whose COMMENT mentions the deploy mutation', () => {
    // The previous matcher searched raw file text, so a comment saying "we
    // deliberately do NOT call serviceInstanceDeploy" failed the build over
    // prose. A check that blocks a merge on a sentence teaches people it is
    // noise, and this one only works if it is believed.
    //
    // Distinct from the variable-upsert case below: that proves endpoint-vs-
    // mutation discrimination, this proves comment-vs-code.
    withFixture(
      {
        '.github/workflows/notes-only.yml':
          '# This service is deployed by a Railway trigger, so we deliberately\n' +
          '# do NOT call serviceInstanceDeploy from CI. See docs/runbooks/deploy.md.\n' +
          'name: Something else entirely\n' +
          'on: { workflow_dispatch: {} }\n' +
          'jobs:\n' +
          '  noop:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      - run: echo hello\n',
      },
      ({ code, out }) => {
        assert.equal(code, 0, `expected pass, got:\n${out}`);
        assert.doesNotMatch(out, /uncovered/);
      }
    );
  });

  it('still flags a real deploy call in a workflow that also has comments', () => {
    // The positive control for the comment-stripping above: stripping must not
    // be so eager that it hides a genuine call sitting beside prose.
    withFixture(
      {
        '.github/workflows/deploy-commented.yml':
          '# Deploys the thing. Related: serviceInstanceDeploy notes in the runbook.\n' +
          'name: Deploy with commentary\n' +
          'on: { workflow_dispatch: {} }\n' +
          'jobs:\n' +
          '  deploy:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      # fire it\n' +
          '      - run: curl "$API" --data \'{"query":"mutation { serviceInstanceDeploy(serviceId: \\"x\\") }"}\'\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /uncovered: \.github\/workflows\/deploy-commented\.yml/);
      }
    );
  });

  it('does not flag a workflow that merely reads Railway', () => {
    // sync-registry-funpay-secret.yml upserts variables against the same API and
    // deploys nothing. Matching the endpoint rather than the mutation would drag
    // it in and demand a build closure it does not have.
    withFixture(
      {
        '.github/workflows/sync-some-secret.yml':
          'name: Sync a variable\n' +
          'on: { workflow_dispatch: {} }\n' +
          'jobs:\n' +
          '  sync:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      - run: curl https://backboard.railway.app/graphql/v2 --data \'{"query":"mutation { variableCollectionUpsert(input: $i) }"}\'\n',
      },
      ({ code, out }) => {
        assert.equal(code, 0, `expected pass, got:\n${out}`);
        assert.doesNotMatch(out, /uncovered/);
      }
    );
  });

  it('refuses to report coverage when a COPY source does not resolve from the repo root', () => {
    // Either the path is stale or the build context moved. Both mean the check
    // is measuring the wrong thing, and a green result would be a lie about a
    // build that no longer exists.
    withFixture(
      {
        'services/registry-service/Dockerfile':
          'FROM node:22-alpine\nCOPY services/ghost-module/ ./services/ghost-module/\n',
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /premise no longer holds/);
        assert.match(out, /does not exist at the repo root/);
      }
    );
  });

  it('refuses to report coverage when the Dockerfile is gone', () => {
    // If the service stopped being Dockerfile-built, this check has nothing to
    // derive coverage from and would otherwise pass on a stale assumption.
    withFixture({ 'services/registry-service/Dockerfile': null }, ({ code, out }) => {
      assert.equal(code, 1, `expected failure, got:\n${out}`);
      assert.match(out, /premise no longer holds/);
    });
  });

  it('refuses to report coverage when the filter uses paths-ignore', () => {
    // The check models an allow-list. Against an exclusion list its answer is
    // meaningless, so it declines rather than guessing.
    withFixture(
      {
        '.github/workflows/deploy-registry-funpay.yml': GOOD_WORKFLOW.replace(
          '    paths:',
          '    paths-ignore:\n      - "docs/**"\n    paths:'
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /premise no longer holds/);
        assert.match(out, /paths-ignore/);
      }
    );
  });
  it('passes a dispatch-only deploy workflow, and says it deploys by hand only', () => {
    // deploy-underwriting.yml has no push trigger by decision, so there is no
    // filter to cover. The sign-off must not fold it into "watches everything".
    withFixture({}, ({ code, out }) => {
      assert.equal(code, 0, `expected pass, got:\n${out}`);
      assert.match(out, /underwriting-service: .* is workflow_dispatch only/);
      assert.match(out, /Deployed by hand only: underwriting-service\./);
      assert.doesNotMatch(out, /✓ underwriting-service/);
    });
  });

  it('FAILS when a dispatch-only workflow gains a push trigger while TARGETS still says dispatchOnly', () => {
    // The push decision and this check must change together. Otherwise the new
    // `paths:` filter would ship unchecked — the silent direction again.
    const withPush = UW_WORKFLOW.replace(
      'on:\n  workflow_dispatch: {}\n',
      "on:\n  push:\n    branches: [main]\n    paths:\n      - 'services/underwriting-service/**'\n  workflow_dispatch: {}\n"
    );
    assert.notEqual(withPush, UW_WORKFLOW);
    withFixture({ '.github/workflows/deploy-underwriting.yml': withPush }, ({ code, out }) => {
      assert.equal(code, 1, `expected failure, got:\n${out}`);
      assert.match(out, /now has a `push:` trigger, but TARGETS marks underwriting-service as dispatchOnly/);
      assert.match(out, /remove `dispatchOnly`/);
    });
  });

  it('FAILS on the one-line `on: [push, ...]` spelling too', () => {
    const inline = UW_WORKFLOW.replace('on:\n  workflow_dispatch: {}\n', 'on: [push, workflow_dispatch]\n');
    withFixture({ '.github/workflows/deploy-underwriting.yml': inline }, ({ code, out }) => {
      assert.equal(code, 1, `expected failure, got:\n${out}`);
      assert.match(out, /now has a `push:` trigger/);
    });
  });

  it('still checks the build premise of a dispatch-only service', () => {
    // No filter to cover is not the same as nothing to check: when a push
    // trigger is approved, the filter must be derived from the real build.
    withFixture({ 'services/underwriting-service/Dockerfile': null }, ({ code, out }) => {
      assert.equal(code, 1, `expected failure, got:\n${out}`);
      assert.match(out, /underwriting-service: this check's premise no longer holds/);
    });
  });

  it('FAILS when the underwriting workflow declares no RAILWAY_SERVICE_NAME', () => {
    // That service is identified by name (resolved to an id at deploy time),
    // so the key this check reads is RAILWAY_SERVICE_NAME, not _ID.
    withFixture(
      {
        '.github/workflows/deploy-underwriting.yml': UW_WORKFLOW.replace(
          '  RAILWAY_SERVICE_NAME: underwriting-service\n',
          ''
        ),
      },
      ({ code, out }) => {
        assert.equal(code, 1, `expected failure, got:\n${out}`);
        assert.match(out, /deploy-underwriting\.yml declares no `RAILWAY_SERVICE_NAME`/);
      }
    );
  });
});
