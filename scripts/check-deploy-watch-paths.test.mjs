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
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
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

/** Runs the real script against a fixture. Never throws — the exit code is the assertion. */
function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
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
});
