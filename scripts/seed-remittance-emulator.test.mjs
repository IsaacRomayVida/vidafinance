/**
 * The remittance emulator seed writes to the local emulator or nowhere.
 * Pure checks: nothing here loads firebase-admin or opens a socket.
 *
 *   node --test scripts/seed-remittance-emulator.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BULK_MAX,
  DEFAULT_PROJECT,
  SeedRefusal,
  bankReferenceDocId,
  buildReferenceIndex,
  buildRemittances,
  daysBefore,
  normalizeBankReference,
  parseArgs,
  resolveEmulatorTarget,
  statusOf,
  todayInMexicoCity,
} from './seed-remittance-emulator.mjs';

const SCRIPT = fileURLToPath(new URL('./seed-remittance-emulator.mjs', import.meta.url));
const EMULATOR_ENV = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
const refuses = (opts, env, pattern) =>
  assert.throws(() => resolveEmulatorTarget({ project: null, ...opts }, env), (err) => err instanceof SeedRefusal && pattern.test(err.message));

test('the default target is the demo project on the local emulator', () => {
  assert.deepEqual(resolveEmulatorTarget({ project: null }, EMULATOR_ENV), {
    projectId: DEFAULT_PROJECT,
    firestoreHost: '127.0.0.1:8080',
    authHost: '127.0.0.1:9099',
  });
  assert.ok(DEFAULT_PROJECT.startsWith('demo-'));
  assert.equal(resolveEmulatorTarget({ project: 'demo-other' }, EMULATOR_ENV).projectId, 'demo-other');
  assert.equal(resolveEmulatorTarget({ project: null }, { ...EMULATOR_ENV, GCLOUD_PROJECT: 'demo-from-env' }).projectId, 'demo-from-env');
});

test('without both emulator hosts it refuses — the Admin SDK would reach a real project', () => {
  refuses({}, {}, /must both be set/);
  refuses({}, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, /must both be set/);
  refuses({}, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }, /must both be set/);
  refuses({ project: 'demo-funpay-local' }, {}, /must both be set/);
});

test('a host that is not loopback is refused', () => {
  refuses({}, { ...EMULATOR_ENV, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }, /not a loopback/);
  refuses({}, { ...EMULATOR_ENV, FIREBASE_AUTH_EMULATOR_HOST: '10.0.0.8:9099' }, /not a loopback/);
  refuses({}, { ...EMULATOR_ENV, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080@evil.example:443' }, /not a loopback/);
  refuses({}, { ...EMULATOR_ENV, FIRESTORE_EMULATOR_HOST: 'localhost' }, /not a loopback/);
});

test('production is refused wherever it is named, even with the emulator hosts set', () => {
  refuses({ project: 'vida-finance' }, EMULATOR_ENV, /PRODUCTION/);
  refuses({ project: 'Vida-Finance ' }, EMULATOR_ENV, /PRODUCTION/);
  refuses({}, { ...EMULATOR_ENV, GCLOUD_PROJECT: 'vida-finance' }, /PRODUCTION/);
  refuses({}, { ...EMULATOR_ENV, GOOGLE_CLOUD_PROJECT: 'vida-finance' }, /PRODUCTION/);
  refuses({ project: 'funpay-prod' }, EMULATOR_ENV, /PRODUCTION/);
});

test('any project that is not demo-* is refused: there is no real-project mode', () => {
  refuses({ project: 'funpay-staging' }, EMULATOR_ENV, /must be demo-\*/);
  refuses({ project: 'demo' }, EMULATOR_ENV, /must be demo-\*/);
  refuses({ project: 'my-demo-project' }, EMULATOR_ENV, /must be demo-\*/);
  refuses({}, { ...EMULATOR_ENV, GCLOUD_PROJECT: 'funpay-staging' }, /must be demo-\*/);
});

test('a service-account key in the environment is refused outright', () => {
  refuses({}, { ...EMULATOR_ENV, GOOGLE_APPLICATION_CREDENTIALS: '/keys/anything.json' }, /GOOGLE_APPLICATION_CREDENTIALS/);
});

test('there is no flag that widens the target', () => {
  assert.deepEqual(parseArgs([]), { project: null, bulk: 0, dryRun: false, help: false });
  assert.deepEqual(parseArgs(['--project', 'demo-x', '--bulk', '60', '--dry-run']), { project: 'demo-x', bulk: 60, dryRun: true, help: false });
  for (const argv of [['--allow-production'], ['--force'], ['--bulk'], ['--bulk', '-1'], ['--bulk', '1.5'], ['--bulk', String(BULK_MAX + 1)], ['--project']]) {
    assert.throws(() => parseArgs(argv), SeedRefusal, argv.join(' '));
  }
});

test('run for real with no emulator configured: exits 2 and writes nothing', () => {
  const env = { PATH: process.env.PATH ?? '' };
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Refusing: FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must both be set/);
  assert.doesNotMatch(run.stdout, /SEED DONE/);

  const prod = spawnSync(process.execPath, [SCRIPT, '--project', 'vida-finance'], { env: { ...env, ...EMULATOR_ENV }, encoding: 'utf8' });
  assert.equal(prod.status, 2);
  assert.match(prod.stderr, /PRODUCTION/);
});

test('--dry-run prints the plan and exits 0 without loading the Admin SDK', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--dry-run', '--bulk', '3'], {
    env: { PATH: process.env.PATH ?? '', ...EMULATOR_ENV },
    encoding: 'utf8',
  });
  assert.match(out, /Target: EMULATOR, project demo-funpay-local/);
  assert.match(out, /9 remittances/);
  assert.match(out, /Dry run — nothing was written\./);
  assert.doesNotMatch(out, /SEED DONE/);
});

test('dates: Mexico City today, and calendar arithmetic across a month end', () => {
  assert.equal(todayInMexicoCity(new Date('2026-03-11T03:30:00Z')), '2026-03-10');
  assert.equal(daysBefore('2026-03-02', 3), '2026-02-27');
  assert.equal(daysBefore('2028-03-01', 1), '2028-02-29');
});

test('the seed covers every state the screen draws, with figures that agree with their receipts', () => {
  const today = '2026-10-13';
  const remittances = buildRemittances(today);
  const by = Object.fromEntries(remittances.map((r) => [r.batchId, r]));
  const overdueDays = (r) => {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.payPeriodEnd}T00:00:00Z`)) / 86400000);
    return Math.max(0, days - 7);
  };

  assert.deepEqual(
    remittances.map((r) => [r.batchId, r.status]),
    [
      ['seed-batch-current', 'expected'],
      ['seed-batch-overdue', 'expected'],
      ['seed-batch-partial', 'partial'],
      ['seed-batch-received', 'received'],
      ['seed-batch-voided', 'partial'],
      ['seed-batch-overpaid', 'overpaid'],
    ],
  );
  assert.equal(overdueDays(by['seed-batch-current']), 0);
  assert.equal(overdueDays(by['seed-batch-overdue']), 18);
  assert.equal(overdueDays(by['seed-batch-partial']), 3);
  assert.equal(overdueDays(by['seed-batch-voided']), 48);

  for (const r of remittances) {
    assert.ok(Number.isInteger(r.expectedCents) && r.expectedCents > 0, r.batchId);
    const live = r.receipts.filter((x) => !x.voided);
    assert.equal(r.receivedCents, live.reduce((s, x) => s + x.amountCents, 0), r.batchId);
    assert.equal(r.status, statusOf(r.expectedCents, r.receivedCents), r.batchId);
    assert.ok(r.payPeriodStart < r.payPeriodEnd && r.payPeriodEnd <= today, r.batchId);
    // Every receipt is one the callable itself would have accepted.
    for (const x of r.receipts) assert.ok(x.receivedOn >= r.payPeriodStart && x.receivedOn <= today, `${r.batchId} ${x.receiptId}`);
  }

  // The voided receipt does not count, and frees its reference.
  const voided = by['seed-batch-voided'].receipts.find((x) => x.voided);
  assert.equal(voided.amountCents, 2000000);
  assert.equal(by['seed-batch-voided'].receivedCents, 500000);
  assert.ok(voided.voidReason.length >= 3);

  const index = buildReferenceIndex(remittances);
  assert.equal(index.length, 4);
  assert.ok(!index.some((e) => e.bankReferenceKey === normalizeBankReference(voided.bankReference)));
  for (const e of index) assert.equal(e.id, bankReferenceDocId(e.bankReferenceKey));
});

test('reference keys and ids match what the callables compute', () => {
  assert.equal(normalizeBankReference('  spei-seed  0001 '), 'SPEI-SEED 0001');
  // sha256 of the normalised key, hex — bankReferenceDocId() in remittanceLedger.ts.
  assert.equal(bankReferenceDocId('SPEI-SEED-0001'), '2a07112a3300de6301deb725b53b185be7c3a48dc1de8ab56c674701cf91391d');
});

test('--bulk adds plain outstanding batches with unique ids, older than the hand-made ones', () => {
  const remittances = buildRemittances('2026-10-13', 120);
  assert.equal(remittances.length, 126);
  assert.equal(new Set(remittances.map((r) => r.batchId)).size, 126);
  const bulk = remittances.filter((r) => r.batchId.startsWith('seed-bulk-'));
  assert.ok(bulk.every((r) => r.status === 'expected' && r.payPeriodEnd < '2026-08-19'));
});
