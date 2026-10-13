#!/usr/bin/env node
/**
 * Seeds (or tears down) the pool of load-test employees requestLoan needs.
 * Runbook: docs/runbooks/scaling.md § Load test.
 *
 *   # Default — the Firebase emulator. Nothing leaves the machine.
 *   firebase emulators:exec --only firestore,auth --project demo-vida-load \
 *     "node tests/load/seed/seed-load-pool.mjs --count 200"
 *
 *   # See what would happen, anywhere, without reading or writing anything
 *   node tests/load/seed/seed-load-pool.mjs --project <staging-project-id> --dry-run
 *
 *   # A real NON-production project (explicit --project is mandatory)
 *   GOOGLE_APPLICATION_CREDENTIALS=<key for that project> LOAD_TEST_PASSWORD=<generated> \
 *     node tests/load/seed/seed-load-pool.mjs --project <staging-project-id>
 *
 *   # Remove the pool and the loans / audit rows a run created
 *   … node tests/load/seed/seed-load-pool.mjs --project <staging-project-id> --teardown
 *
 * Flags: --count N (default 12500) · --employers N (default count/50) ·
 *        --project ID · --dry-run · --teardown · --concurrency N (default 20)
 *
 * The production project is refused in guard.mjs and there is no flag for it.
 */

import { readFileSync } from 'node:fs';

import { SeedRefusal, parseArgs, resolvePassword, resolveSeedTarget } from './guard.mjs';
import { describePlan, seedPool, teardownPool } from './seed-lib.mjs';

function credentialsProjectId(env) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).project_id ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }

  const target = resolveSeedTarget(opts, process.env, credentialsProjectId(process.env));
  for (const line of describePlan(opts, target)) console.log(line);
  if (opts.dryRun) return;

  const password = opts.teardown ? null : resolvePassword(target.mode, process.env);

  // Imported only now: a refused or dry run never loads the Admin SDK at all.
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore, FieldPath, FieldValue } = await import('firebase-admin/firestore');

  const app = initializeApp({ projectId: target.projectId });
  if (app.options.projectId !== target.projectId) {
    throw new SeedRefusal(`Refusing: Admin SDK resolved project "${app.options.projectId}", expected "${target.projectId}".`);
  }
  const deps = { db: getFirestore(app), auth: getAuth(app), log: (line) => console.log(line) };

  if (opts.teardown) {
    const result = await teardownPool({ ...deps, documentId: FieldPath.documentId() });
    console.log(`TEARDOWN DONE ${JSON.stringify(result)}`);
  } else {
    const result = await seedPool(
      { ...deps, serverTimestamp: () => FieldValue.serverTimestamp() },
      { count: opts.count, employers: opts.employers, password, concurrency: opts.concurrency }
    );
    console.log(`SEED DONE ${JSON.stringify(result)}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof SeedRefusal ? err.message : err);
    process.exit(err instanceof SeedRefusal ? 2 : 1);
  }
);
