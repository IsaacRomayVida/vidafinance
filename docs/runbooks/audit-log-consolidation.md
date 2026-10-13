# Runbook — Audit log consolidation (`auditLogs` → `audit_log`)

**Status:** migration script committed, **not run against any real project**.
Rehearsed on the Firestore emulator with seeded data on 2026-10-13 (dry run, real run,
idempotent re-run — all passed; see § Rehearsal).
**Owner:** platform / ops.
**Related:** gap D5 in `docs/LAUNCH_CHECKLIST_v1.8.md`.

---

## What is already true

The write-side consolidation is **done and verified in code**. There is nothing
to fix in the application:

- Every audit writer goes through `functions/src/utils/auditLog.ts`
  (`AUDIT_LOG_COLLECTION = 'audit_log'`, `buildAuditLogDocument`). Writers:
  `index.ts` (inline `auditLog()` helper), `admin/adminClaims.ts`,
  `employers/approveEmployer.ts`, `loans/markLoanDisbursed.ts`,
  `loans/updateLoanStatus.ts`, `loans/onLoanStatusChange.ts`,
  `config/loanConfigAdmin.ts`, `scheduled/dailyLoanCheck.ts`, and
  `scripts/bootstrap-super-admin.js`.
- **`auditLogs` has no writer anywhere in the tree.** Verified by grep across
  `functions/`, `services/`, `public/`, `public-v2/`, `scripts/`, `tests/`.
- `firestore.rules` and `firestore.indexes.json` both target `audit_log`
  (4 composite indexes). Client writes to both collections are impossible
  (`allow write: if false`).

## What is still open

The **data**. Records written before the consolidation still live in
`auditLogs`, and for role grant/revoke history that is the only copy.
`firestore.rules:217` deliberately keeps ops read on the legacy collection so
that history is not stranded — but:

- the ops audit console (`public/js/app.js:2602`) queries `audit_log` only, so
  legacy rows are invisible in the UI;
- `auditLogs` has no composite indexes, so ad-hoc ordered queries against it
  will fail or require manual index creation.

**Net effect during an incident:** forensics still has two places to look, and
the second is reachable only by hand. That is the residue of D5.

---

## Procedure

### How to invoke the script

`ts-node` is **not** a dependency of this repo, so `npx ts-node …` would fetch an unpinned
package at run time — not acceptable on an audit-trail migration. Compile with the repo's
pinned `tsc` into the gitignored `.test-build/` and run that:

```bash
npm ci   # repo root, once
npx tsc --outDir .test-build/migration-002 --rootDir . --module commonjs --target es2020 \
  --esModuleInterop --skipLibCheck --strict \
  scripts/migrations/002_consolidate_audit_logs.ts scripts/migrations/002_emulator_rehearsal.ts
MIGRATE=.test-build/migration-002/scripts/migrations
```

The first line the script prints is its target, e.g.
`Target: project=vida-finance  (LIVE Firestore — not an emulator)`. **Read it before anything
else; Ctrl-C if it is not the project you meant.**

### Rehearsal (emulator, seeded) — do this first, on the release commit

```bash
# Temp config on non-default ports; delete it afterwards.
cat > firebase.rehearsal.tmp.json <<'JSON'
{ "firestore": { "rules": "firestore.rules" },
  "emulators": { "firestore": { "port": 8391 }, "hub": { "port": 4491 },
                 "logging": { "port": 4591 }, "ui": { "enabled": false } } }
JSON
firebase emulators:start --config firebase.rehearsal.tmp.json --only firestore --project demo-audit-rehearsal &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8391 GCLOUD_PROJECT=demo-audit-rehearsal node $MIGRATE/002_emulator_rehearsal.js
FIRESTORE_EMULATOR_HOST=127.0.0.1:8391 GCLOUD_PROJECT=demo-audit-rehearsal node $MIGRATE/002_consolidate_audit_logs.js --dry-run
kill %1; rm firebase.rehearsal.tmp.json
```

`002_emulator_rehearsal.ts` refuses to run unless `FIRESTORE_EMULATOR_HOST` is set **and** the
project is `demo-*`. It seeds 27 `auditLogs` rows (25 timestamped, 5 of them with unknown
fields; 2 without a timestamp) plus one native `audit_log` row, then checks the properties below.

Result on 2026-10-13 (branch `swarm2/ops-prep`, firebase-tools emulator, exit 0):

```
PASS  dry run left audit_log unchanged
PASS  migrated rows = 25 (expected 25 = legacy − skipped)
PASS  spot-check legacy_seed_7: action/actorUid/targetId/timestamp match the original
PASS  re-run added no rows
PASS  re-run left content identical
PASS  auditLogs unchanged (copy-only)
PASS  native audit_log row unchanged
REHEARSAL PASSED
```

The CLI entry point's own `--dry-run` against the same emulator printed
`Target: project=demo-audit-rehearsal  EMULATOR=127.0.0.1:8391`, planned 25 copies and 2 skips,
and exited **1** (skips are a non-zero exit, in a dry run too — by design). The same properties
are unit-tested without an emulator in
`scripts/migrations/__tests__/002_consolidate_audit_logs.test.ts` (`npm run test:migrations`).

### 0. Prerequisites

- Firebase credentials with Firestore read/write on the target project
  (`GOOGLE_APPLICATION_CREDENTIALS` or `firebase login:ci` default credentials).
- A Firestore export taken immediately before step 3 (see below).
- Sign-off from the on-call engineer. This touches the audit trail; do not run
  it unattended.

### 1. Measure

Confirm the legacy collection is small enough to migrate in one pass and see
what is actually in it:

```bash
# Count. If this is large (>10k), review batching before proceeding.
firebase firestore:query auditLogs --project <PROJECT> --limit 1000 | wc -l
```

Record the count. You will reconcile against it in step 4.

### 2. Dry run

```bash
GCLOUD_PROJECT=<PROJECT> node $MIGRATE/002_consolidate_audit_logs.js --dry-run | tee dry-run-002.log
```

Writes nothing. It prints each destination document it would create and lists
any record it would skip. **Read the skip list.** A record is skipped only when
it has no usable `timestamp`; those need a human decision and will otherwise
remain only in `auditLogs`.

### 3. Back up, then run

```bash
gcloud firestore export gs://<BACKUP_BUCKET>/pre-audit-consolidation-$(date +%Y%m%d) \
  --collection-ids=auditLogs,audit_log --project <PROJECT>

GCLOUD_PROJECT=<PROJECT> node $MIGRATE/002_consolidate_audit_logs.js | tee run-002.log
```

The script is **copy-only and idempotent**:

- it never deletes from `auditLogs`;
- each legacy record maps to a deterministic id `audit_log/legacy_<sourceId>`,
  so a re-run after a partial failure overwrites its own output rather than
  duplicating;
- it aborts rather than overwrite a destination id it did not itself write;
- it preserves the **original** `timestamp` (stamping the migration time would
  relabel old grants as having happened today, making the trail misleading);
- unrecognised legacy fields are preserved under `meta.legacyFields`.

Exit code is non-zero if anything was skipped.

### Sign-offs — what each one must actually check

Two people: the on-call engineer who runs it, and a second reviewer (ops/compliance) who
reads the logs. Neither box is ticked from memory — each item names its evidence.

**Before step 3 (run):**

- [ ] Rehearsal above passed **on the commit being run** (paste the PASS block).
- [ ] `dry-run-002.log` first line names the intended project and says `LIVE Firestore`.
- [ ] Dry-run "Found N" equals the step-1 count. If not, someone is writing to `auditLogs` —
      stop: the write side was supposed to be consolidated.
- [ ] Every skipped id in the dry run has a written decision (fix the source row by hand, or
      accept that it stays only in `auditLogs`).
- [ ] The dry run did **not** throw `Refusing to overwrite` (a native `audit_log/legacy_*` id).
- [ ] The `gcloud firestore export` finished and its `gs://` path is recorded in the ticket.

**After step 3, before closing D5:**

- [ ] `run-002.log` "copied" count = dry-run "to copy" count.
- [ ] Step 4 verification done (count query, console filters, one role-grant spot check);
      record the spot-checked source id.
- [ ] A second `--dry-run` now plans the same N copies (all onto existing `legacy_*` ids —
      re-running is safe) and no new skips.

### 4. Verify

- Count documents in `audit_log` where `_migrationTag == '002_consolidate_audit_logs'`.
  It must equal (step 1 count − skipped count).
- In the ops console audit tab, confirm migrated rows render and that
  `action` / `targetId` filters return them.
- Spot-check one migrated role-grant record against its `auditLogs` original:
  `action`, `actorUid`, `targetId` and `timestamp` must match.

### 5. Retire the legacy collection — SEPARATE CHANGE, LATER

Do **not** bundle this with the migration.

Once the migrated copies have been verified *and* have survived a backup cycle,
a follow-up PR may:

1. remove the `match /auditLogs/{docId}` block from `firestore.rules`;
2. remove the `auditLogs` legacy-read tests from `firestore.rules.test.ts`;
3. delete the `auditLogs` section from `DATABASE.md`.

Deleting the legacy documents themselves is optional and not recommended before
the retention window for the audit trail has elapsed — check the current
retention policy first.

---

## Rollback

Nothing to roll back in the application: the script only adds documents.

If the migrated rows are wrong, delete the documents in `audit_log` where
`_migrationTag == '002_consolidate_audit_logs'`. The originals in `auditLogs`
are untouched and remain the source of truth. Then restore from the step-3
export if anything else was disturbed.

---

## Invariants this must not break

These are checked by tests; re-run both suites after any change here.

1. **Audit before privilege.** `onEmployerDocCreated`, `setAdminClaim` and
   `revokeAdminClaim` write the audit record *before* minting the claim, so a
   failed audit write aborts the grant. Pinned by
   `functions/src/employers/__tests__/onEmployerDocCreated.test.ts` and
   `functions/src/admin/__tests__/adminClaims.test.ts`.
2. **No client writes.** Both collections are `allow write: if false`. Pinned by
   `firestore.rules.test.ts`.
3. **No stranded history.** Ops retains read on `auditLogs` until the migration
   has run and been verified.

```bash
# migration unit tests (dry-run writes nothing, idempotent re-run, native-id refusal)
npm run test:migrations
# functions
cd functions && npm test
# rules
firebase emulators:exec --only firestore --project demo-vida-finance-test "npm run test:rules"
```
