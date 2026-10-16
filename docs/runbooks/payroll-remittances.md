# Payroll remittances (E18) — ledger, callables, overdue alert, backfill

What the employer deducted from payroll against what actually arrived at the bank.
Code: `functions/src/payroll/remittance.ts` (callables),
`functions/src/payroll/remittanceLedger.ts` (arithmetic, document shape and the ordered query,
shared with the backfill script) and `functions/src/scheduled/remittanceOverdueCheck.ts` (daily
alert). Background: `AUDIT_EMPLOYER_PATH.md` E18.

All money is **integer centavos**. All dates are `YYYY-MM-DD` strings; "today" is always
the date in `America/Mexico_City`.

## Data

### `payrollRemittances/{batchId}`

`batchId` is the payroll batch id, `{employerId}_{payPeriodStart}_{payPeriodEnd}`.

| Field | Written by | Notes |
|---|---|---|
| `batchId`, `employerId`, `payPeriodStart`, `payPeriodEnd` | expected side | |
| `expectedCents`, `deductionCount` | expected side | Sum of the batch's `payrollDeductions`, each row converted to centavos before adding. |
| `receivedCents` | callables | Always recomputed as the sum of non-voided receipts. |
| `status` | both | `expected` (nothing received) / `partial` / `received` / `overpaid`. Derived from the two figures. |
| `lastReceivedOn` | callables | Latest `receivedOn` among non-voided receipts, or `null`. |
| `receipts[]` | callables | Append-only. A voided receipt stays, marked. |
| `createdOnDemandBy` | `recordPayrollRemittance` | uid, only on a record created by a receipt against a pre-ledger batch. |
| `overdueAlertEpoch` | expected side, `voidPayrollRemittanceReceipt` | The record's overdue-alert cycle; absent means 0. Goes up by one each time a settled record (nothing outstanding) owes money again — a void took a receipt back out, or a retried batch raised `expectedCents`. See the overdue alert below. |
| `backfilledBy` | backfill script | `004_backfill_payroll_remittances`, only on backfilled records. |

"Expected side" is `processPayroll` for every batch since E18, and the backfill script or
`recordPayrollRemittance` for older batches. All three use the same function.

A receipt:

```
{ receiptId, amountCents, receivedOn, bankReference, bankReferenceKey, recordedBy, recordedAt,
  voided?, voidedBy?, voidedAt?, voidReason? }
```

Receipts booked before this version have no `receiptId` or `bankReferenceKey`. Their id is
`legacy-<index in receipts[]>` (the array never shrinks or reorders, so the index is stable),
and their key is computed on read.

Rules: the batch's employer admin and ops can read the document; no client can write it. The
employer therefore sees its own receipts, including voided ones and the void reason.

### `payrollRemittanceReferences/{sha256(bankReferenceKey)}`

`{ bankReferenceKey, holders: [{ batchId, receiptId, employerId }], updatedAt }` — which
non-voided receipts currently hold a bank reference. Written in the same transaction as the
receipt. No client access (rules deny everything). The document is removed when its last
holder is voided; the history is the voided receipt and the audit log, not this index.

### Bank reference normalisation

`bankReferenceKey` = the reference NFKC-normalised, trimmed, inner whitespace collapsed to one
space, upper-cased. Punctuation is kept. The original (trimmed) text is stored as
`bankReference`.

- Within a batch, a key held by a non-voided receipt is always refused.
- Across batches, a key held by another batch is refused **unless** the caller passes
  `sharedTransfer: true` — one SPEI transfer that really pays several batches. The audit entry
  then records `meta.sharedTransferWith`.
- Limit: the cross-batch check sees only receipts that have an index entry. A receipt booked
  before the index existed has none until the backfill below has run with `--apply` (its
  second pass writes them), so until then the same reference on a *different* batch is not
  caught. (Within its own batch it is.) There was no ops UI before the index, so few or no
  such receipts should exist.

## Callables

All three: region `us-central1`, App Check enforced, roles `ops`, `admin`, `super_admin`.
Any other role gets `permission-denied`; no auth gets `unauthenticated`. Rate limits are per
uid and fail closed (`resource-exhausted` / `unavailable` from the shared limiter).

### Refusal reasons (`details.reason`)

Every `invalid-argument`, `not-found` and `already-exists` these callables throw carries
`details.reason`, a stable machine-readable code. **The `message` is English and meant for
logs; the UI shows its own Spanish text keyed on the reason.** Codes are a contract: new ones
may be added, existing ones are never renamed. `details.field` names the input field at fault
when there is one. (`permission-denied`, `unauthenticated` and the rate limiter's errors come
from shared middleware and carry no reason.)

| `reason` | Code | Callable | Meaning | Extra `details` |
|---|---|---|---|---|
| `input-invalid` | `invalid-argument` | all | The argument is missing or not an object | — |
| `batch-id-invalid` | `invalid-argument` | record, void | `batchId` missing, empty or over 200 chars | `field` |
| `amount-invalid` | `invalid-argument` | record | `amountCents` missing, not an integer, not > 0, or beyond the safe integer range | `field` |
| `received-on-invalid-format` | `invalid-argument` | record | `receivedOn` missing or not `YYYY-MM-DD` | `field` |
| `received-on-not-a-date` | `invalid-argument` | record | `YYYY-MM-DD` but no such day (2026-02-30) | `field` |
| `received-on-future` | `invalid-argument` | record | After today in Mexico City | `field`, `today` |
| `received-on-before-pay-period` | `invalid-argument` | record | Before the batch's `payPeriodStart` (see below) | `field`, `payPeriodStart` |
| `bank-reference-invalid` | `invalid-argument` | record | Blank after trimming, or over 100 chars | `field` |
| `shared-transfer-invalid` | `invalid-argument` | record | `sharedTransfer` is not a boolean | `field` |
| `receipt-id-invalid` | `invalid-argument` | void | `receiptId` missing, empty or over 200 chars | `field` |
| `void-reason-invalid` | `invalid-argument` | void | `reason` missing, under 3 or over 500 chars after trimming | `field` |
| `view-invalid` | `invalid-argument` | list | `view` is not `outstanding` or `all` | `field` |
| `employer-id-invalid` | `invalid-argument` | list | `employerId` empty or over 200 chars | `field` |
| `overdue-only-invalid` | `invalid-argument` | list | `overdueOnly` is not a boolean | `field` |
| `grace-days-invalid` | `invalid-argument` | list | `graceDays` is not an integer 0–365 | `field` |
| `limit-invalid` | `invalid-argument` | list | `limit` is not an integer 1–500 | `field` |
| `cursor-invalid` | `invalid-argument` | list | `cursor` is not a `nextCursor` this callable issued **for a view sorted the same way** | `field` |
| `remittance-not-expected` | `not-found` | record | No record, and no such batch or the batch deducted nothing | — |
| `remittance-not-found` | `not-found` | void | No record for the batch | — |
| `receipt-not-found` | `not-found` | void | No receipt with that id on the record | — |
| `bank-reference-in-batch` | `already-exists` | record | Reference already on a non-voided receipt of this batch | `batchIds: [batchId]` |
| `bank-reference-in-other-batch` | `already-exists` | record | Reference held by another batch and `sharedTransfer` not `true` | `batchIds: [...]` |

When several fields are wrong at once, the reason is for the first one in input order.
No remittance callable throws `failed-precondition`.

### `recordPayrollRemittance`

Input:

```ts
{
  batchId: string;          // 1–200 chars
  amountCents: number;      // integer > 0
  receivedOn: string;       // YYYY-MM-DD, a real date, >= the batch's payPeriodStart, <= today in Mexico City
  bankReference: string;    // 1–100 chars after trimming
  sharedTransfer?: boolean; // acknowledge that this transfer also pays another batch
}
```

Output:

```ts
{
  batchId: string;
  receiptId: string;        // pass this to voidPayrollRemittanceReceipt
  expectedCents: number;
  receivedCents: number;
  status: 'expected' | 'partial' | 'received' | 'overpaid';
  createdRecord: boolean;   // true if the batch predated the ledger and its record was created now
}
```

Errors: see the reasons table above (`batch-id-invalid`, `amount-invalid`, the five
`received-on-*` / `bank-reference-invalid` / `shared-transfer-invalid` reasons,
`remittance-not-expected`, and the two `bank-reference-in-*` reasons).

The UI should offer "this transfer covers both batches" only on
`bank-reference-in-other-batch`, and resend with `sharedTransfer: true`.

**`receivedOn` bounds.** Upper: today in Mexico City. Lower: the batch's `payPeriodStart`.
Money withheld from a pay period cannot have been remitted before that period began, so an
earlier date is a typo (wrong year, wrong batch). The bound is the period *start*, not its
end: an employer that runs payroll early may legitimately remit before the period closes.
The check uses the `payPeriodStart` stored on the record (or, for a pre-ledger batch, on the
`payrollBatches` document the record is created from). If that field is missing or not a real
date the lower bound is skipped — an unreadable period is not a reason to refuse money.

Audit: `payrollRemittances.received`, `targetId` = batchId, `before`/`after` =
`{ receivedCents, status }`, `meta` = `{ employerId, receiptId, amountCents, receivedOn,
bankReference, bankReferenceKey, createdRecord?, expectedCents?, sharedTransferWith? }`.

Rate limit: 20 per 60 s.

### `voidPayrollRemittanceReceipt`

Input:

```ts
{
  batchId: string;   // 1–200 chars
  receiptId: string; // from recordPayrollRemittance or listPayrollRemittances
  reason: string;    // required, 3–500 chars after trimming
}
```

Output:

```ts
{
  batchId: string;
  receiptId: string;
  expectedCents: number;
  receivedCents: number;   // recomputed without the voided receipt
  status: 'expected' | 'partial' | 'received' | 'overpaid';
  alreadyVoided: boolean;  // true: it was voided before, nothing changed, no audit entry written
}
```

Errors: `batch-id-invalid`, `receipt-id-invalid`, `void-reason-invalid`,
`remittance-not-found`, `receipt-not-found` (reasons table above).

The receipt is never deleted: it stays in `receipts[]` with `voided: true`, `voidedBy`,
`voidedAt`, `voidReason`. Its bank reference becomes reusable, on this batch or another.
Calling it twice is safe.

Audit: `payrollRemittances.receiptVoided`, `targetId` = batchId, `before`/`after` =
`{ receivedCents, status }`, `meta` = `{ employerId, receiptId, amountCents, receivedOn,
bankReference, recordedBy, reason }`.

Rate limit: 20 per 60 s.

### `listPayrollRemittances`

Input (all optional; the whole argument may be omitted):

```ts
{
  view?: 'outstanding' | 'all'; // default 'outstanding' = status expected or partial
  employerId?: string;
  overdueOnly?: boolean;        // only records past the grace window with money missing
  graceDays?: number;           // integer 0–365, default 7
  limit?: number;               // page size, integer 1–500, default 500
  cursor?: string;              // nextCursor of the previous page
}
```

Output:

```ts
{
  asOf: string;      // Mexico City date the aging was computed against
  graceDays: number;
  pageSize: number;  // the page size this call used
  nextCursor: string | null; // pass back as `cursor` for the next page; null on the last page
  truncated: boolean;        // === (nextCursor !== null); kept for callers written before pagination
  totals: { count, expectedCents, receivedCents, outstandingCents, overdueCount, overdueCents }; // THIS PAGE only
  // EVERY record the filters match, across all pages. First page (no cursor) only; null on
  // later pages and when the totals walk failed. complete: false = stopped at its cap.
  matchingTotals: { count, expectedCents, receivedCents, outstandingCents, overdueCount, overdueCents, complete } | null;
  remittances: Array<{
    batchId: string;
    employerId: string | null;
    payPeriodStart: string | null;
    payPeriodEnd: string | null;
    expectedCents: number;
    receivedCents: number;
    status: 'expected' | 'partial' | 'received' | 'overpaid';
    deductionCount: number;
    lastReceivedOn: string | null;
    aging: {
      outstandingCents: number;          // max(0, expected - received)
      daysSincePeriodEnd: number | null; // null if payPeriodEnd is unreadable
      daysOverdue: number;               // days past payPeriodEnd + graceDays, else 0
      overdue: boolean;
      bucket: 'settled' | 'current' | 'overdue_1_15' | 'overdue_16_30' | 'overdue_31_plus';
    };
    receipts: Array<{
      receiptId: string;
      amountCents: number;
      receivedOn: string | null;
      bankReference: string | null;
      recordedBy: string | null;   // uid
      recordedAt: string | null;   // ISO 8601
      voided: boolean;
      voidedBy: string | null;
      voidedAt: string | null;     // ISO 8601
      voidReason: string | null;
    }>;
  }>;
}
```

Errors: `view-invalid`, `employer-id-invalid`, `overdue-only-invalid`, `grace-days-invalid`,
`limit-invalid`, `cursor-invalid` (reasons table above).

Rate limit: 60 per 60 s.

#### Order and pagination (changed 2026-10-13)

The list is one ordered Firestore query (`remittancesQuery` in `remittanceLedger.ts`), paged
with a cursor. Before this it read up to 500 documents in no particular order and sorted
those, so past 500 matches the oldest debts could be the ones cut.

| Request | Order |
|---|---|
| `view: 'outstanding'` (default), or any request with `overdueOnly: true` | `payPeriodEnd` ascending, then `batchId` ascending — **oldest outstanding first** |
| `view: 'all'` without `overdueOnly` | `payPeriodEnd` descending, then `batchId` descending — newest first |

- The order is total, so walking `nextCursor` to `null` returns every matching record exactly
  once, however many there are. Rows are returned in that order; the server does not re-sort.
- For the outstanding view the order is the same one the old in-memory sort produced
  (longest overdue first, then oldest period first). **`view: 'all'` changed**: it used to put
  outstanding records first and settled ones last; it is now newest pay period first.
- `overdueOnly` implies outstanding, whatever `view` says (it always did: a settled record is
  never overdue).
- A cursor is opaque and belongs to the sort direction it was issued for. Reusing an
  `outstanding` cursor on `view: 'all'` (or the reverse) is refused with `cursor-invalid`.
  Changing `employerId`, `overdueOnly` or `graceDays` mid-walk is not refused; start again
  from the first page when a filter changes.
- A page can hold fewer than `limit` rows while `nextCursor` is still set: a row whose stored
  `status` disagrees with its figures is dropped after the read. Use `nextCursor`, not the row
  count, to decide whether there is more.
- **`totals` cover the returned page only**, as they always covered only the returned rows.
  With one page (`nextCursor: null`) they are the totals of everything that matched.
- **`matchingTotals` cover everything the filters match** (added 2026-10-16). Worked out on
  the first page only, by walking the same ordered query to the end with `select` on
  `expectedCents`, `receivedCents`, `payPeriodEnd` (1,000 per read, at most 40 reads =
  40,000 records), summed with the same derivation as the rows — status from the figures,
  aging from the period end — so they cannot disagree with the rows. It uses the indexes the
  list already needs; no new index. It costs one document read per matching record per
  first-page call; a Firestore `sum()` aggregation would be cheaper but would trust the stored
  `status` and need composite indexes over the summed fields. If the walk hits its cap it
  returns `complete: false` (and logs a warning); if it fails the page is still returned, with
  `matchingTotals: null`.
- Backwards compatible for a caller that sends neither `limit` nor `cursor`: same fields, same
  first 500 rows in the same order for the outstanding view, `truncated` still says whether
  more exist. New fields: `pageSize`, `nextCursor`.
- A record with no `payPeriodEnd` is not listed (Firestore leaves documents without the sort
  field out of an ordered query). Every writer sets it.

Composite indexes (in `firestore.indexes.json`, collection `payrollRemittances`):

| Fields | Serves |
|---|---|
| `status` ASC, `payPeriodEnd` ASC | outstanding / overdue list; the overdue alert |
| `employerId` ASC, `status` ASC, `payPeriodEnd` ASC | outstanding / overdue list for one employer |
| `employerId` ASC, `payPeriodEnd` DESC | `view: 'all'` for one employer |

`view: 'all'` without an employer uses the automatic single-field index. **The indexes must
exist before the functions that query them serve traffic.** `deploy.yml` deploys functions
before indexes, and an index takes minutes to build, so on the first deploy of this change
the list and the alert can fail with `FAILED_PRECONDITION` until the build finishes. The
emulator does not enforce composite indexes, so they have not been exercised anywhere yet;
check the first production call (and the Firebase console's index list) after deploying.

Things to know:

- **The grace period is a display default, not a contract term.** No remittance deadline is
  stored per employer. `overdue` means "more than `graceDays` days after `payPeriodEnd` with
  money still missing". Decide the real term with the business before treating the flag as a
  breach.
- It lists only batches that have a record. Pre-ledger batches appear after the backfill
  below, or once a receipt is booked against them.

## Overdue alert: `remittanceOverdueCheck`

`functions/src/scheduled/remittanceOverdueCheck.ts`, scheduled daily at 09:30
`America/Mexico_City`. It walks the outstanding records past the grace window (the same
ordered query as the list) and raises each one through the two channels the other monitors
already use. No new secret, collection, rule or service.

- **`incident_log`** — one document per alert, shown live on the ops Alerts page
  (`/ops/alerts`, "system" filter) and dismissed there (`resolved: true`; the rules let ops
  change nothing else). Fields: `source: 'remittance-overdue'`, `error` (the Spanish line the
  page prints), `severity`, `ts`, `resolved`, plus `batchId`, `employerId`, `payPeriodEnd`,
  `expectedCents`, `receivedCents`, `outstandingCents`, `daysOverdue`, `thresholdDays`,
  `alertEpoch`, `graceDays`, `asOf`. When the system closes one it adds `resolved: true`,
  `resolvedAt`, `resolvedBy: 'system'` and `resolution` (below).
- **Slack** — one summary line per run that raised something, through `sendSlackAlert`. Like
  every other caller it does nothing unless `SLACK_WEBHOOK_URL` is set on Functions. Whether
  it is set in production has not been checked; `incident_log` is the channel to rely on.

Rules:

- **One alert per record per threshold per cycle.** Thresholds are 1, 16 and 31 days overdue —
  the lower edges of the aging buckets. `severity` is `warning` for 1 and 16, `critical` for 31.
- The document id is `remittance-overdue_<threshold>d_<batchId>` in cycle 0 (unchanged from
  before cycles existed) and `remittance-overdue_e<cycle>_<threshold>d_<batchId>` after that,
  written with `create()`. A second run the same day, a retried run or two overlapping runs
  cannot raise the same alert twice, and an alert ops dismissed is not raised again in the same
  cycle.
- **A record re-opened after it was settled starts a new cycle** (`overdueAlertEpoch`), so it
  can raise every threshold again — including ones the settled cycle already raised.
- A record first seen already past several thresholds (after the backfill, or after the
  scheduler was down) gets one alert, for the highest threshold. Lower ones are not back-filled.
- It uses the default 7-day grace. That is a display default, not an agreed term, so an alert
  means "late by our default", not "in breach".
- **Alerts close themselves when the money arrives.** The receipt that leaves a record with
  nothing outstanding closes that cycle's open alerts in the same transaction
  (`resolution: 'remittance-received'`; the audit entry lists them in `meta.resolvedAlerts`).
  Each run of the check also walks every open `remittance-overdue` alert (equality filters on
  `source` and `resolved` — no composite index) and closes the ones whose record is no longer
  overdue (`'no-longer-overdue'`) or has moved on to a later cycle (`'superseded'`), whatever
  settled it. An alert whose record cannot be found is left open. An alert ops already
  dismissed is not touched.
- If an alert cannot be written or closed the sweep carries on, logs it, and the run fails at
  the end; the next run does what was missed.
- **Page cap.** Each walk (open alerts, outstanding records) reads at most 50 pages of 200
  (10,000 documents). A run that stops at the cap with more left to read logs an error, writes
  a `critical` incident `remittance-overdue-check_<date>` (source `remittance-overdue-check`,
  one per day) and a critical Slack line, and fails. If that ever fires, raise `MAX_PAGES` in
  `remittanceOverdueCheck.ts` — the ledger has outgrown it.

## Backfill: `scripts/migrations/004_backfill_payroll_remittances.ts`

Two passes, both dry-run by default:

1. **Records.** Creates the record for every `completed` batch that has deductions and no
   record.
2. **Bank-reference index.** For every non-voided receipt on every record, makes sure
   `payrollRemittanceReferences` names it as a holder of its reference. Receipts booked before
   the index existed have no entry, so the cross-batch duplicate check cannot see them; this
   pass writes the entry `recordPayrollRemittance` would have written
   (`{ batchId, receiptId, employerId }`, with `legacy-<index>` ids and computed keys for
   receipts that predate stored ids and keys). `voidPayrollRemittanceReceipt` releases a
   backfilled entry like any other.

It has **not been run against any real project**. It is unit-tested against an in-memory
Firestore (`npm run test:migrations`) and rehearsed end to end on the Firestore emulator
(§ Rehearsal).

- Dry run by default. `--apply` writes.
- Refuses to run unless `FIRESTORE_EMULATOR_HOST` is set. `--allow-production` overrides
  that, and is required even for a dry run against live data.
- Skips batches that already have a record without writing; never writes to a remittance
  record that exists, receipts included. Pass 2 writes only to `payrollRemittanceReferences`,
  only adds holders, and tags the documents it writes `backfilledBy`.
- Idempotent: run it again after a failure. A second run reports 0 to create and 0 to index.
- A voided receipt, and a receipt with no bank reference, get no index entry. The latter is
  listed (`NO REFERENCE`).
- A reference held by more than one batch is indexed for all of them and listed (`REVIEW`).
  The script does not decide whether that is a real shared transfer or the same transfer
  booked twice — **someone with the bank statement must**. If it was booked twice, void the
  wrong receipt with `voidPayrollRemittanceReceipt`.
- Exits non-zero if any batch document is malformed (no `employerId` or pay period). Those
  are listed and need a human.

`ts-node` is not a repo dependency. Compile with the pinned `tsc`:

```bash
npm ci   # repo root, once
npx tsc --outDir .test-build/migration-004 --rootDir . --module commonjs --target es2020 \
  --esModuleInterop --skipLibCheck --strict \
  scripts/migrations/004_backfill_payroll_remittances.ts scripts/migrations/004_emulator_rehearsal.ts
BACKFILL=.test-build/migration-004/scripts/migrations/004_backfill_payroll_remittances.js
REHEARSAL=.test-build/migration-004/scripts/migrations/004_emulator_rehearsal.js
```

### Rehearsal (emulator, seeded) — do this first, on the release commit

```bash
# Temp config on non-default ports; delete it afterwards.
cat > firebase.rehearsal.tmp.json <<'JSON'
{ "emulators": { "firestore": { "port": 8394 }, "hub": { "port": 4494 },
                 "logging": { "port": 4594 }, "ui": { "enabled": false } } }
JSON
firebase emulators:start --config firebase.rehearsal.tmp.json --only firestore --project demo-remittance-backfill &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8394 GCLOUD_PROJECT=demo-remittance-backfill node $REHEARSAL
FIRESTORE_EMULATOR_HOST=127.0.0.1:8394 GCLOUD_PROJECT=demo-remittance-backfill node $BACKFILL   # dry run: 0 and 0
kill %1; rm firebase.rehearsal.tmp.json
```

`004_emulator_rehearsal.ts` refuses to run unless `FIRESTORE_EMULATOR_HOST` is set **and** the
project is `demo-*`, and it needs an empty emulator (restart it between runs). It seeds 235
batches (231 completed with deductions and no record — more than one page — plus one
in progress, one that deducted nothing, one malformed, one with a native record) and three
existing records: one booked by the current callable with its index entry, and two booked
before the index (four live receipts between them, one voided, one without a reference, one
reference shared by both).

Result on 2026-10-13 (branch `swarm4/remittance-ops`, firebase-tools Firestore emulator
v1.22.0, project `demo-remittance-backfill`, exit 0, 27 checks):

```
=== 1. dry run ===
PASS  dry run left all four collections unchanged
PASS  dry run plans 231 records (expected 231), 1 existing, 1 not completed, 1 nothing deducted, 1 malformed
PASS  dry run plans 3 index entries (expected 3), 1 already indexed, 1 receipt without a reference
=== 2. real run: remittance records ===
PASS  real run did exactly what the dry run announced (records)
PASS  records created = 231 (expected 231)
PASS  spot-check emp1 May batch: 1000.10 + 333.33 pesos = 133343 centavos, status expected, no receipts
PASS  created expected total = 159908 centavos (expected 159908), every amount an integer
PASS  no record for the in-progress, nothing-deducted or malformed batch
=== 3. real run: bank-reference index ===
PASS  real run did exactly what the dry run announced (index)
PASS  index documents = 3 (expected 3: native, SPEI 0001 ABC, SPEI-SHARED-9)
PASS  legacy receipt indexed under its normalised key with its positional id (legacy-0)
PASS  a reference on two batches is indexed for both
PASS  and reported for review as held by legacy_1 and legacy_2
PASS  a voided receipt gets no index entry
PASS  the index entry the callable wrote is byte-for-byte unchanged
=== 4. re-run (idempotency) ===
PASS  re-run left all four collections identical
PASS  re-run: 0 records to create, 0 index entries to create (expected 0 and 0)
=== 5. untouched ===
PASS  payrollBatches unchanged
PASS  payrollDeductions unchanged
PASS  pre-existing remittance records unchanged, receipts included (no id or key stamped onto a legacy receipt)
=== 6. the ordered ledger query on a real Firestore ===
PASS  outstanding query paged 233 records in 3 pages, no repeats (expected 233)
PASS  in order: oldest pay period first, then batch id
PASS  first row is the oldest batch (2025-01-15|bulk_0000)
PASS  periodEndBefore keeps only earlier periods (10, expected 10)
PASS  employer filter with the outstanding filter
PASS  view "all" is newest pay period first (native_1, emp1_2026-05-01_2026-05-15, legacy_2)
REHEARSAL PASSED
```

The CLI entry point's own dry run against the same emulator afterwards printed
`Target: project=demo-remittance-backfill  EMULATOR=127.0.0.1:8394  mode=dry run`, 0 records
to create and 0 entries to index. Run with `FIRESTORE_EMULATOR_HOST` empty and `--apply` it
refused (`Refusing to run: FIRESTORE_EMULATOR_HOST is not set…`, exit 1) before opening any
connection.

What the rehearsal does not show: behaviour on real production data (shapes nobody seeded),
and whether the composite indexes are sufficient — the emulator does not enforce them.

### Production

Needs an owner's go-ahead; the first line printed is the target — read it:

```bash
node $BACKFILL --allow-production            # dry run: review both lists, the total, and every REVIEW line
node $BACKFILL --allow-production --apply
node $BACKFILL --allow-production            # should now report 0 to create and 0 to index
```

## Ops screen: `/ops/remittances`

`public-v2/src/pages/PayrollRemittances.tsx`, under the ops route guard
(`ops`, `admin`, `super_admin`) and listed in the ops navigation as "Remesas".
It only talks to the three callables above; it never writes to Firestore. The
one direct read is `employers`, to show company names instead of ids (the id
is shown if that read fails).

- **List** — `listPayrollRemittances`, outstanding by default, with "Todas"
  and "Solo vencidas" filters. Paged: the screen asks for 50 rows
  (`REMITTANCE_PAGE_SIZE`) and **Cargar más remesas** sends the page's
  `nextCursor` and appends. A filter change starts again from page one with no
  cursor; **Actualizar**, and the reload after a write, ask page one for as
  many rows as were already on screen (capped at 500) so ops keeps their place.
  The four totals are the server's `matchingTotals` for the whole view; while
  not all of it is loaded, a line under them says how many remesas the view has
  and how many are on screen, and the heading reads "N remesas cargadas · hay
  más". If the server sent no complete `matchingTotals`, the totals fall back
  to sums of the rows on screen and a line under them says they cover only what
  is loaded.
  The order is stated next to the as-of date (oldest period first for
  outstanding and overdue, newest first for "Todas"). Each row shows expected /
  received / outstanding, the status, the aging pill (peach up to 15 days
  overdue, red beyond) and every receipt; voided receipts stay visible, struck
  through, with the reason and the day they were voided **as a Mexico City
  date** (`voidedAt` is an instant; 20:00 in Mexico City is already the next
  day in UTC).
- **Registrar transferencia** — amount in pesos (converted to integer
  centavos from the typed digits, never through a float), date, bank
  reference. The client mirrors the server checks (real calendar date, not
  before the batch's `payPeriodStart`, not after today in America/Mexico_City,
  reference 1–100 characters) and the server remains the authority. A
  `bank-reference-in-other-batch` refusal names the other batch and offers a
  resend with `sharedTransfer: true`; `bank-reference-in-batch` offers nothing.
- **Anular** — two steps: a required reason (3–500 characters), then an
  explicit confirmation. Nothing is sent before the second step.
- **Refusals** — every `details.reason` in the table above has Spanish and
  English text (`REMITTANCE_REASON_KEYS` in `public-v2/src/lib/remittance.ts`,
  keys `remit_reason_*` / `remit_err_dup_*`). The server's English `message`
  is never shown. A refusal with no reason, or one the screen does not know,
  falls back to the generic `friendlyError` text.
  `remittanceReasons.parity.test.ts` reads `RemittanceRefusalReason` from the
  functions source and fails when a reason is added there without a text here.

### Running the ops screen locally (emulators only)

A plain `npm run dev` in `public-v2` talks to the **production** project —
`src/lib/firebase.ts` carries production's config. To look at this screen (or
any portal page) without touching production, run it against the Firebase
emulators. Needs the Firebase CLI, Java, and a local Redis (the callables'
rate limiter fails closed without one). Four terminals, from the repo root:

```bash
# 1. Redis for the emulated rate limiter (any free port)
redis-server --port 6397 --save ''

# 2. Emulators, on a demo-* project. Build the functions first.
(cd functions && npm ci && npm run build)
REDIS_URL=redis://127.0.0.1:6397 \
  firebase emulators:start --only auth,firestore,functions,storage --project demo-funpay-local

# 3. Seed: one ops login, three employers, six remittances — current, overdue,
#    partial, fully received, overpaid, and one with a voided receipt.
#    Add --bulk 60 to get more than one page.
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  node scripts/seed-remittance-emulator.mjs

# 4. The web app, wired to the emulators
(cd public-v2 && npm run dev:emulators)     # = VITE_USE_FIREBASE_EMULATORS=true vite
```

Open `http://localhost:3000/login`, sign in as `ops@funpay.test` (the password
is `OPS_PASSWORD` in `scripts/seed-remittance-emulator.mjs`; the account exists
only in the auth emulator), then go to `/ops/remittances`. The browser console
prints `[firebase] EMULATOR MODE — project demo-funpay-local …` when the wiring
is active; if that line is missing, stop — the page is on production.

What keeps this off production:

- **The web app** (`public-v2/src/lib/firebaseEmulators.ts`). Emulator mode
  needs a dev server *and* `VITE_USE_FIREBASE_EMULATORS=true`. The app is then
  initialised with a `demo-*` project id and a placeholder API key, Auth,
  Firestore, Functions and Storage are connected to `127.0.0.1` on the ports in
  `firebase.json`, and App Check uses a local unsigned stand-in instead of
  reCAPTCHA. A project id that is not `demo-*` throws at start-up. In a
  production build every use of that module sits behind `import.meta.env.DEV`
  and is removed; `npm run build` ends with
  `scripts/check-bundle-no-emulators.mjs`, which fails the build if the bundle
  contains any of the emulator strings — so CI and the deploy both check it,
  including when the flag is exported in the shell that builds.
- **The seed** refuses unless both emulator hosts are set and loopback and the
  project id is `demo-*`; it refuses a production project id and any
  `GOOGLE_APPLICATION_CREDENTIALS`, and has no flag for a real project.
  Re-running it puts the seeded remittances back to their starting state.
- **The emulated functions** inherit the shell's environment and any
  `functions/.env*` file. Start them from a shell with no provider keys set.
  The remittance callables call no third party; other pages' callables may.

Known noise: `index.html` loads the MetaMap button script from
`web-button.metamap.com` on every page (the only request the screen makes
outside loopback), and a refused duplicate reference logs an HTTP 409 in the
browser console.

## Correcting a mistake

- Wrong amount, date, reference or batch on a receipt: `voidPayrollRemittanceReceipt` with a
  reason, then `recordPayrollRemittance` again with the right values. The reference is free
  as soon as the void commits.
- Wrong `expectedCents`: it is derived from `payrollDeductions`. Fix the deductions (re-run
  the payroll batch); `processPayroll` rewrites the expected side and keeps the receipts.
