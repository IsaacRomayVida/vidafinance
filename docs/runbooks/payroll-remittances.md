# Payroll remittances (E18) — ledger, callables, backfill

What the employer deducted from payroll against what actually arrived at the bank.
Code: `functions/src/payroll/remittance.ts` (callables) and
`functions/src/payroll/remittanceLedger.ts` (arithmetic and document shape, shared with the
backfill script). Background: `AUDIT_EMPLOYER_PATH.md` E18.

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
- Limit: the cross-batch check sees only receipts booked from this version on. A receipt
  booked earlier has no index entry, so the same reference on a *different* batch is not
  caught. (Within its own batch it is.) There was no ops UI before this version, so few or
  no such receipts should exist.

## Callables

All three: region `us-central1`, App Check enforced, roles `ops`, `admin`, `super_admin`.
Any other role gets `permission-denied`; no auth gets `unauthenticated`. Rate limits are per
uid and fail closed (`resource-exhausted` / `unavailable` from the shared limiter).

### `recordPayrollRemittance`

Input:

```ts
{
  batchId: string;          // 1–200 chars
  amountCents: number;      // integer > 0
  receivedOn: string;       // YYYY-MM-DD, a real date, <= today in Mexico City
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

Errors:

| Code | When | `details` |
|---|---|---|
| `invalid-argument` | Bad shape; non-integer or non-positive amount; `receivedOn` not `YYYY-MM-DD`, not a real date (2026-02-30), or in the future; blank reference | — |
| `not-found` | No record and either no such `payrollBatches` doc or the batch has no deductions | — |
| `already-exists` | Reference already on a non-voided receipt of this batch | `{ reason: 'bank-reference-in-batch', batchIds: [batchId] }` |
| `already-exists` | Reference held by another batch and `sharedTransfer` not `true` | `{ reason: 'bank-reference-in-other-batch', batchIds: [...] }` |

The UI should offer "this transfer covers both batches" only on the second `already-exists`
reason, and resend with `sharedTransfer: true`.

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

Errors: `invalid-argument` (missing or too-short reason, missing ids), `not-found` (no record
for the batch, or no receipt with that id on it).

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
}
```

Output:

```ts
{
  asOf: string;      // Mexico City date the aging was computed against
  graceDays: number;
  truncated: boolean; // true if more than 500 records matched the Firestore query
  totals: { count, expectedCents, receivedCents, outstandingCents, overdueCount, overdueCents };
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

Sorted longest-overdue first, then other outstanding records oldest period first, then settled
ones. `totals` cover the returned rows. Errors: `invalid-argument` only.

Rate limit: 60 per 60 s.

Things to know:

- **The grace period is a display default, not a contract term.** No remittance deadline is
  stored per employer. `overdue` means "more than `graceDays` days after `payPeriodEnd` with
  money still missing". Decide the real term with the business before treating the flag as a
  breach.
- It lists only batches that have a record. Pre-ledger batches appear after the backfill
  below, or once a receipt is booked against them.
- It filters on one Firestore field and does the rest in memory, so it needs no composite
  index. Past 500 matching records it sets `truncated`; add pagination before volumes get
  there.
- Nothing alerts on overdue remittances yet. A scheduled digest would need a scheduler
  function and a notification channel; that is a follow-up.

## Backfill: `scripts/migrations/004_backfill_payroll_remittances.ts`

Creates the record for every `completed` batch that has deductions and no record. It has
**not been run against any real project**; it is tested against an in-memory Firestore only
(`npm run test:migrations`).

- Dry run by default. `--apply` writes.
- Refuses to run unless `FIRESTORE_EMULATOR_HOST` is set. `--allow-production` overrides
  that, and is required even for a dry run against live data.
- Skips batches that already have a record without writing; never touches receipts.
- Idempotent: run it again after a failure.
- Exits non-zero if any batch document is malformed (no `employerId` or pay period). Those
  are listed and need a human.

`ts-node` is not a repo dependency. Compile with the pinned `tsc`:

```bash
npm ci   # repo root, once
npx tsc --outDir .test-build/migration-004 --rootDir . --module commonjs --target es2020 \
  --esModuleInterop --skipLibCheck --strict \
  scripts/migrations/004_backfill_payroll_remittances.ts
BACKFILL=.test-build/migration-004/scripts/migrations/004_backfill_payroll_remittances.js
```

Emulator:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-remittance-backfill node $BACKFILL
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-remittance-backfill node $BACKFILL --apply
```

Production (needs an owner's go-ahead; the first line printed is the target — read it):

```bash
node $BACKFILL --allow-production            # dry run: review the list and the total
node $BACKFILL --allow-production --apply
node $BACKFILL --allow-production            # should now report 0 to create
```

## Ops screen: `/ops/remittances`

`public-v2/src/pages/PayrollRemittances.tsx`, under the ops route guard
(`ops`, `admin`, `super_admin`) and listed in the ops navigation as "Remesas".
It only talks to the three callables above; it never writes to Firestore. The
one direct read is `employers`, to show company names instead of ids (the id
is shown if that read fails).

- **List** — `listPayrollRemittances`, outstanding by default, with "Todas"
  and "Solo vencidas" filters. Totals are the server's `totals` block. Each
  row shows expected / received / outstanding, the status, the aging pill
  (peach up to 15 days overdue, red beyond) and every receipt; voided receipts
  stay visible, struck through, with the reason.
- **Registrar transferencia** — amount in pesos (converted to integer
  centavos from the typed digits, never through a float), date, bank
  reference. The client mirrors the server checks (real calendar date, not
  after today in America/Mexico_City, reference 1–100 characters) and the
  server remains the authority. A `bank-reference-in-other-batch` refusal
  names the other batch and offers a resend with `sharedTransfer: true`;
  `bank-reference-in-batch` offers nothing.
- **Anular** — two steps: a required reason (3–500 characters), then an
  explicit confirmation. Nothing is sent before the second step.

## Correcting a mistake

- Wrong amount, date, reference or batch on a receipt: `voidPayrollRemittanceReceipt` with a
  reason, then `recordPayrollRemittance` again with the right values. The reference is free
  as soon as the void commits.
- Wrong `expectedCents`: it is derived from `payrollDeductions`. Fix the deductions (re-run
  the payroll batch); `processPayroll` rewrites the expected side and keeps the receipts.
