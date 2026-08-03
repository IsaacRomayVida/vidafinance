# Runbook — Audit log consolidation (`auditLogs` → `audit_log`)

**Status:** migration script committed, **not run in any environment**.
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
npx ts-node scripts/migrations/002_consolidate_audit_logs.ts --dry-run
```

Writes nothing. It prints each destination document it would create and lists
any record it would skip. **Read the skip list.** A record is skipped only when
it has no usable `timestamp`; those need a human decision and will otherwise
remain only in `auditLogs`.

### 3. Back up, then run

```bash
gcloud firestore export gs://<BACKUP_BUCKET>/pre-audit-consolidation-$(date +%Y%m%d) \
  --collection-ids=auditLogs,audit_log --project <PROJECT>

npx ts-node scripts/migrations/002_consolidate_audit_logs.ts
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
# functions
cd functions && npm test
# rules
firebase emulators:exec --only firestore --project demo-vida-finance-test "npm run test:rules"
```
