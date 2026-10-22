#!/usr/bin/env node
/**
 * Seeds the Firebase EMULATOR with what the ops remittance screen
 * (/ops/remittances) needs to be looked at: one ops login, three employers and
 * a handful of payroll remittances, one in each state the screen draws.
 * Runbook: docs/runbooks/payroll-remittances.md § Running the ops screen locally.
 *
 *   # with the emulators already running (--project demo-funpay-local):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     node scripts/seed-remittance-emulator.mjs
 *
 * Flags: --project demo-<id> (default demo-funpay-local) · --bulk N (0–600 extra
 *        outstanding batches, to see paging; default 0) · --dry-run · --help
 *
 * EMULATOR ONLY. Both emulator hosts must be set and loopback and the project
 * id must be demo-*; anything else is refused before the Admin SDK is loaded,
 * and there is no flag that changes that. The ops login below exists only in
 * the emulator's auth store.
 *
 * Re-running puts the seeded remittances back to their starting state (it
 * overwrites them) and leaves anything else in the emulator alone. Dates are
 * relative to today in Mexico City, so "overdue" stays overdue on any day.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROJECT = 'demo-funpay-local';
/** The real project (.firebaserc). Named so the refusal can say so; a non-demo id is refused anyway. */
export const PRODUCTION_PROJECT_IDS = Object.freeze(['vida-finance']);
export const OPS_EMAIL = 'ops@funpay.test';
/** Emulator-only. This account cannot exist anywhere but the local auth emulator. */
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password -- Local emulator or fixture value, not a real credential
export const OPS_PASSWORD = 'emulator-only-ops-login';
export const OPS_UID = 'seed-ops-user';
export const BULK_MAX = 600;

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
const TIME_ZONE = 'America/Mexico_City';

export class SeedRefusal extends Error {}
const refuse = (message) => {
  throw new SeedRefusal(`Refusing: ${message}`);
};

/** @param {string[]} argv process.argv.slice(2) */
export function parseArgs(argv) {
  const opts = { project: null, bulk: 0, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new SeedRefusal(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--project') opts.project = value();
    else if (arg === '--bulk') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > BULK_MAX) throw new SeedRefusal(`--bulk must be an integer 0–${BULK_MAX}, got ${raw}`);
      opts.bulk = n;
    } else throw new SeedRefusal(`Unknown argument ${arg} (there is no flag that allows a real project)`);
  }
  return opts;
}

/**
 * Where this seed may write: the local emulator, a demo-* project, or nowhere.
 * Pure — decided from argv and the environment before anything is imported.
 *
 * @param {{ project: string|null }} opts
 * @param {Record<string, string|undefined>} env
 * @returns {{ projectId: string, firestoreHost: string, authHost: string }}
 */
export function resolveEmulatorTarget(opts, env) {
  const firestoreHost = env.FIRESTORE_EMULATOR_HOST || '';
  const authHost = env.FIREBASE_AUTH_EMULATOR_HOST || '';

  for (const [label, id] of [
    ['--project', opts.project],
    ['GCLOUD_PROJECT', env.GCLOUD_PROJECT],
    ['GOOGLE_CLOUD_PROJECT', env.GOOGLE_CLOUD_PROJECT],
  ]) {
    const normalised = String(id ?? '').trim().toLowerCase();
    if (normalised && (PRODUCTION_PROJECT_IDS.includes(normalised) || /prod/.test(normalised))) {
      refuse(`${label} is "${id}", a PRODUCTION project. This seed only ever writes to the local emulator.`);
    }
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    refuse(
      'GOOGLE_APPLICATION_CREDENTIALS is set. The emulator needs no credentials, and a seed that holds ' +
        'a real service-account key is one typo away from a real project. Unset it and run again.',
    );
  }
  if (!firestoreHost || !authHost) {
    refuse(
      'FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must both be set (for example 127.0.0.1:8080 and ' +
        '127.0.0.1:9099). Without them the Admin SDK would talk to a real project.',
    );
  }
  for (const [name, host] of [
    ['FIRESTORE_EMULATOR_HOST', firestoreHost],
    ['FIREBASE_AUTH_EMULATOR_HOST', authHost],
  ]) {
    if (!LOOPBACK.test(host)) refuse(`${name}="${host}" is not a loopback host:port.`);
  }
  const projectId = opts.project || env.GCLOUD_PROJECT || DEFAULT_PROJECT;
  if (!/^demo-[a-z0-9-]+$/.test(projectId)) {
    refuse(`the project id must be demo-* (got "${projectId}"); a demo-* project can never reach Google.`);
  }
  return { projectId, firestoreHost, authHost };
}

// ─── What gets written ───────────────────────────────────────────────────────

export function todayInMexicoCity(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** YYYY-MM-DD `days` calendar days before `iso`. */
export function daysBefore(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Same normalisation and id as functions/src/payroll/remittanceLedger.ts, so the callables find these entries. */
export const normalizeBankReference = (raw) => raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
export const bankReferenceDocId = (key) => createHash('sha256').update(key, 'utf8').digest('hex');

/** Mirrors remittanceStatus(): the stored status only ever agrees with the two figures. */
export function statusOf(expectedCents, receivedCents) {
  if (receivedCents <= 0) return 'expected';
  if (receivedCents < expectedCents) return 'partial';
  return receivedCents === expectedCents ? 'received' : 'overpaid';
}

export const EMPLOYERS = Object.freeze([
  { id: 'seed-emp-caribe', companyName: 'Hotel Caribe Maya' },
  { id: 'seed-emp-tulum', companyName: 'Resort Tulum Azul' },
  // Long on purpose: the row has to survive a real razón social.
  { id: 'seed-emp-operadora', companyName: 'Operadora Hotelera y de Servicios Turísticos del Caribe Mexicano, S.A. de C.V.' },
]);

/**
 * The seeded remittances, one per state the screen draws. Money is integer
 * centavos. `ends` is how many days ago the pay period closed; with the
 * default 7 grace days a record is overdue from day 8.
 *
 * @param {string} today YYYY-MM-DD in Mexico City
 * @param {number} bulk extra plain outstanding batches
 */
export function buildRemittances(today, bulk = 0) {
  const period = (ends) => ({ payPeriodStart: daysBefore(today, ends + 14), payPeriodEnd: daysBefore(today, ends) });
  const receipt = (n, amountCents, receivedDaysAgo, extra = {}) => ({
    receiptId: `seed-receipt-${n}`,
    amountCents,
    receivedOn: daysBefore(today, receivedDaysAgo),
    bankReference: `SPEI-SEED-000${n}`,
    recordedBy: OPS_UID,
    ...extra,
  });
  const base = [
    // Nothing received, still inside the grace period.
    { batchId: 'seed-batch-current', employerId: 'seed-emp-operadora', ...period(3), expectedCents: 1845000, deductionCount: 14, receipts: [] },
    // Nothing received, 18 days overdue.
    { batchId: 'seed-batch-overdue', employerId: 'seed-emp-tulum', ...period(25), expectedCents: 2412550, deductionCount: 19, receipts: [] },
    // Part of it arrived; 3 days overdue.
    { batchId: 'seed-batch-partial', employerId: 'seed-emp-caribe', ...period(10), expectedCents: 1560000, deductionCount: 12, receipts: [receipt(1, 900000, 6)] },
    // Fully received: only the "all" view shows it.
    { batchId: 'seed-batch-received', employerId: 'seed-emp-tulum', ...period(40), expectedCents: 980075, deductionCount: 8, receipts: [receipt(2, 980075, 36)] },
    // A receipt booked on the wrong batch and voided, then a smaller real one; 48 days overdue.
    {
      batchId: 'seed-batch-voided',
      employerId: 'seed-emp-caribe',
      ...period(55),
      expectedCents: 2000000,
      deductionCount: 16,
      receipts: [
        receipt(3, 2000000, 50, { voided: true, voidedBy: OPS_UID, voidedDaysAgo: 49, voidReason: 'Se capturó en el lote equivocado' }),
        receipt(4, 500000, 48),
      ],
    },
    // More arrived than was expected.
    { batchId: 'seed-batch-overpaid', employerId: 'seed-emp-tulum', ...period(18), expectedCents: 750000, deductionCount: 6, receipts: [receipt(5, 760000, 15)] },
  ];
  const extra = Array.from({ length: bulk }, (_, i) => ({
    batchId: `seed-bulk-${String(i + 1).padStart(3, '0')}`,
    employerId: EMPLOYERS[i % 2].id,
    // Spread over the past, two per day, all older than the hand-made ones.
    ...period(60 + Math.floor(i / 2)),
    expectedCents: 100000 + i * 1250,
    deductionCount: 1 + (i % 9),
    receipts: [],
  }));
  return [...base, ...extra].map((r) => {
    const receivedCents = r.receipts.reduce((sum, x) => (x.voided ? sum : sum + x.amountCents), 0);
    const live = r.receipts.filter((x) => !x.voided).map((x) => x.receivedOn).sort();
    return { ...r, receivedCents, status: statusOf(r.expectedCents, receivedCents), lastReceivedOn: live[live.length - 1] ?? null };
  });
}

/** The `payrollRemittanceReferences` entries for every receipt that still counts. */
export function buildReferenceIndex(remittances) {
  return remittances.flatMap((r) =>
    r.receipts
      .filter((x) => !x.voided)
      .map((x) => {
        const bankReferenceKey = normalizeBankReference(x.bankReference);
        return {
          id: bankReferenceDocId(bankReferenceKey),
          bankReferenceKey,
          holders: [{ batchId: r.batchId, receiptId: x.receiptId, employerId: r.employerId }],
        };
      }),
  );
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
    return;
  }
  const target = resolveEmulatorTarget(opts, process.env);
  const today = todayInMexicoCity();
  const remittances = buildRemittances(today, opts.bulk);
  const references = buildReferenceIndex(remittances);

  console.log(`Target: EMULATOR, project ${target.projectId} (firestore ${target.firestoreHost}, auth ${target.authHost})`);
  console.log(`Plan:   1 ops user, ${EMPLOYERS.length} employers (each with its admin user), ${remittances.length} remittances, ${references.length} reference-index entries (today in Mexico City: ${today})`);
  if (opts.dryRun) {
    for (const r of remittances.slice(0, 6)) console.log(`  ${r.batchId}: ${r.status}, period ends ${r.payPeriodEnd}, ${r.receipts.length} receipt(s)`);
    console.log('Dry run — nothing was written.');
    return;
  }

  // Imported only now: a refused or dry run never loads the Admin SDK.
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore, FieldValue, Timestamp } = await import('firebase-admin/firestore');

  const app = initializeApp({ projectId: target.projectId });
  if (app.options.projectId !== target.projectId) {
    refuse(`the Admin SDK resolved project "${app.options.projectId}", expected "${target.projectId}".`);
  }
  const auth = getAuth(app);
  const db = getFirestore(app);

  const upsertUser = async (uid, fields, claims) => {
    // Email is marked verified because Login.tsx refuses an unverified one.
    const user = { password: OPS_PASSWORD, emailVerified: true, ...fields };
    try {
      await auth.updateUser(uid, user);
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') throw err;
      await auth.createUser({ uid, ...user });
    }
    await auth.setCustomUserClaims(uid, claims);
  };

  await upsertUser(OPS_UID, { email: OPS_EMAIL, displayName: 'Ops (emulador)' }, { role: 'ops' });
  await db.collection('users').doc(OPS_UID).set({ email: OPS_EMAIL, role: 'ops', seeded: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  for (const e of EMPLOYERS) {
    // An employer document's id is its admin's uid, and onEmployerDocCreated
    // sets that user's claims — so the user has to exist before the document.
    await upsertUser(e.id, { email: `${e.id}@funpay.test`, displayName: e.companyName }, { role: 'employer_admin', employerId: e.id });
    await db.collection('employers').doc(e.id).set({ companyName: e.companyName, status: 'active', seeded: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  const at = (iso, hour) => Timestamp.fromDate(new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00-06:00`));
  const writer = db.bulkWriter();
  for (const r of remittances) {
    void writer.set(db.collection('payrollRemittances').doc(r.batchId), {
      batchId: r.batchId,
      employerId: r.employerId,
      payPeriodStart: r.payPeriodStart,
      payPeriodEnd: r.payPeriodEnd,
      expectedCents: r.expectedCents,
      deductionCount: r.deductionCount,
      receivedCents: r.receivedCents,
      status: r.status,
      lastReceivedOn: r.lastReceivedOn,
      receipts: r.receipts.map(({ voidedDaysAgo, ...x }) => ({
        ...x,
        bankReferenceKey: normalizeBankReference(x.bankReference),
        recordedAt: at(x.receivedOn, 11),
        // 20:00 in Mexico City is already the next day in UTC — the case the screen must get right.
        ...(x.voided ? { voidedAt: at(daysBefore(today, voidedDaysAgo), 20) } : {}),
      })),
      seeded: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const ref of references) {
    void writer.set(db.collection('payrollRemittanceReferences').doc(ref.id), {
      bankReferenceKey: ref.bankReferenceKey,
      holders: ref.holders,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await writer.close();

  console.log(`SEED DONE — sign in at /login as ${OPS_EMAIL} (password: OPS_PASSWORD in scripts/seed-remittance-emulator.mjs), then open /ops/remittances.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof SeedRefusal ? err.message : err);
      process.exit(err instanceof SeedRefusal ? 2 : 1);
    },
  );
}
