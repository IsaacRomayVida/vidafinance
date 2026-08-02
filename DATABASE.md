# VIDA Finance — Firestore Data Model

> Canonical reference for all Firestore collections. Updated for v1.7.

## Data Model Pattern

**Flat collections only.** All top-level documents use denormalized foreign-key fields (e.g., `employerId`, `employeeId`) for cross-collection relationships. No subcollections are used.

---

## Collections

### `employers/{employerId}`

Employer organizations. The document ID is the employer's Firebase Auth UID.

| Field | Type | Description |
|---|---|---|
| `companyName` | string | Legal company name |
| `name` | string | Contact person name |
| `email` | string | Primary contact email |
| `phone` | string | Contact phone |
| `contactName` | string | Secondary contact name |
| `contactEmail` | string | Secondary contact email |
| `contactPhone` | string | Secondary contact phone |
| `rfc` | string | Mexican tax ID (RFC) |
| `bankClabe` | string | CLABE interbank code |
| `employerCode` | string | Internal employer code |
| `companySize` | number | Number of employees |
| `payrollSystem` | string | Payroll system name |
| `yearsActive` | number | Years in operation |
| `satStatus` | string | SAT registration status |
| `industry` | string | Industry vertical |
| `status` | string | `pending` \| `active` \| `rejected_ml` |
| `activatedAt` | timestamp | When the employer was approved |
| `riskTier` | number | ML-assigned risk tier |
| `mlScore` | number | ML underwriting score |
| `mlDecisionId` | string | ML decision reference |
| `llmAnalysis` | map | LLM-generated analysis |
| `mlScoredAt` | timestamp | When ML scoring occurred |
| `activeLoans` | number | Count of active loans (denormalized) |
| `totalDisbursed` | number | Total disbursed amount (denormalized) |
| `currentOutstandingBalance` | number | Outstanding balance (denormalized) |

**Access:** Owner (employer), ops, admin.

---

### `employees/{employeeId}`

Employee profiles. The document ID is the employee's Firebase Auth UID.

| Field | Type | Description |
|---|---|---|
| `employerId` | string | FK → `employers/{employerId}` |
| `employerName` | string | Denormalized employer name |
| `name` | string | Full name |
| `email` | string | Email address |
| `phone` | string | Phone number |
| `address` | string | Home address |
| `bankClabe` | string | CLABE for disbursements |
| `bankName` | string | Bank name |
| `monthlySalary` | number | Monthly salary (MXN) |
| `availableCredit` | number | Remaining borrowing capacity |
| `active` | boolean | Whether employee is active |
| `userId` | string | Firebase Auth UID (same as doc ID) |

**Access:** Owner (employee), employer (via `employerId` match), ops, admin.

**Indexes:**
- `employerId` + `active` (composite) — used by `getEmployerDashboard`

---

### `loans/{loanId}`

Loan applications and lifecycle. Document ID is a nanoid.

| Field | Type | Description |
|---|---|---|
| `employeeId` | string | FK → `employees/{employeeId}` |
| `employeeName` | string | Denormalized |
| `employeeEmail` | string | Denormalized |
| `employeePhone` | string | Denormalized |
| `employerId` | string | FK → `employers/{employerId}` |
| `employerName` | string | Denormalized |
| `employerCode` | string | Denormalized |
| `amount` | number | Principal amount (MXN) |
| `fee` | number | Service fee (MXN) |
| `total` | number | `amount + fee` |
| `term` | number | Loan term in days |
| `status` | string | `pending` \| `approved` \| `rejected` \| `disbursement_queued` \| `disbursed` \| `active` \| `overdue` \| `paid` \| `repaid` |
| `dueDate` | timestamp | Repayment due date |
| `disbursedAt` | timestamp | When funds were sent |
| `disbursementRef` | string | SPEI transfer reference |
| `disbursementError` | string | Disbursement failure reason |
| `paidAt` | timestamp | When repayment was received |
| `paidAmount` | number | Amount repaid |
| `repaymentRef` | string | Payment reference |
| `conektaOrderId` | string | Conekta payment order ID |
| `paymentUrl` | string | Payment link URL |
| `paymentLinkGeneratedAt` | timestamp | When payment link was created |
| `overdueDetectedAt` | timestamp | When overdue status was detected |
| `softcreditoDeductionId` | string | SoftCredito deduction reference |
| `contractUrl` | string | Signed contract PDF URL |
| `receiptUrl` | string | Receipt PDF URL |
| `statusNote` | string | Note from status change |
| `mlDecisionId` | string | ML decision reference |
| `mlCreditScore` | number | ML credit score |
| `mlDefaultProb` | number | ML default probability |
| `createdAt` | timestamp | Request timestamp |
| `acceptedAt` | timestamp | Terms acceptance timestamp |
| `requestedAt` | timestamp | Alias for createdAt |

**Access:** Owner (employee), employer (via `employerId`), ops, admin. All writes via Admin SDK only.

**Indexes:**
- `employerId` + `createdAt` desc
- `employerId` + `status` + `createdAt` desc
- `employeeId` + `createdAt` desc
- `status` + `dueDate`
- `status` + `overdueDetectedAt` desc

---

### `disbursement_queue/{loanId}`

Queued disbursements awaiting SPEI transfer. Admin SDK only.

| Field | Type | Description |
|---|---|---|
| `loanId` | string | FK → `loans/{loanId}` |
| `employeeId` | string | FK → `employees/{employeeId}` |
| `employeeName` | string | Denormalized |
| `employerName` | string | Denormalized |
| `amount` | number | Disbursement amount |
| `total` | number | Total including fee |
| `clabe` | string | Destination CLABE |
| `bankName` | string | Bank name |
| `concept` | string | Transfer concept (e.g., `VIDA-ABCD1234`) |
| `status` | string | `queued` \| `processing` \| `completed` \| `failed` |
| `queuedAt` | timestamp | When queued |

**Indexes:** `status` + `queuedAt`

---

### `repayments/{docId}`

Completed repayment records. Immutable after creation.

| Field | Type | Description |
|---|---|---|
| `loanId` | string | FK → `loans/{loanId}` |
| `employeeId` | string | FK → `employees/{employeeId}` |
| `paidAt` | timestamp | Payment timestamp |

**Indexes:** `loanId` + `paidAt` desc, `employeeId` + `paidAt` desc

---

### `audit_log/{docId}`

Immutable audit trail for all business-critical actions. **This is the only audit
collection.** Writers must go through `functions/src/utils/auditLog.ts`
(`buildAuditLogDocument`) so the shape cannot drift per call site.

| Field | Type | Description |
|---|---|---|
| `action` | string | Action identifier (e.g., `loan.requested`, `employer.approved`, `admin.setRole`) |
| `actorUid` | string | UID of the actor |
| `actorRole` | string | Role of the actor |
| `actorEmail` | string \| null | Email of the actor when known; rendered by the ops audit tab |
| `targetCollection` | string | Derived from action prefix |
| `targetId` | string | Target document ID |
| `before` | map \| null | State before change |
| `after` | map \| null | State after change |
| `meta` | map | Additional metadata |
| `timestamp` | timestamp | Server timestamp (or the transaction's `Timestamp` for transactional writers) |

**Indexes:** `actorUid` + `timestamp` desc, `targetId` + `timestamp` desc,
`action` + `timestamp` desc, `targetCollection` + `timestamp` desc

**Durability:** audit writes on privilege-escalation paths (`admin.setRole`,
`admin.revokeRole`, `employer.setCustomClaims`, `employer.claimGrantedOnCreate`)
are fail-hard — the mutation does not happen if the record cannot be written.
Audit writes on lower-risk paths are still best-effort, so this log is
*investigable*, not *tamper-evident*: do not describe it as compliance-grade.

### `auditLogs/{docId}` — legacy, read-only

Retired camelCase collection. It has no writers; records created before the
consolidation still live here and remain ops-readable. No data migration was run.

---

### `overdue_log/{loanId}`

Overdue loan tracking. Written by `dailyLoanCheck` scheduler.

| Field | Type | Description |
|---|---|---|
| `loanId` | string | FK → `loans/{loanId}` |
| `employeeId` | string | FK → `employees/{employeeId}` |
| `employerId` | string | FK → `employers/{employerId}` |
| `employeeName` | string | Denormalized |
| `amount` | number | Total owed |
| `dueDate` | timestamp | Original due date |
| `daysOverdue` | number | Days past due |
| `detectedAt` | timestamp | Detection timestamp |
| `resolved` | boolean | Whether resolved |

**Indexes:** `resolved` + `detectedAt` desc

---

### `portfolio_snapshots/{date}`

Weekly portfolio state snapshots. Date string as document ID (e.g., `2026-03-21`).

| Field | Type | Description |
|---|---|---|
| `snapshotDate` | string | ISO date |
| `totalActive` | number | Active loan count |
| `totalOverdue` | number | Overdue loan count |
| `totalPaid` | number | Paid loan count |
| `totalDisbursedMXN` | number | Total disbursed amount |
| `totalOutstandingMXN` | number | Total outstanding amount |
| `overdueRate` | number | Overdue ratio (0–1) |
| `snapshotAt` | timestamp | Snapshot timestamp |

---

### `system_health/{docId}`

System health state. Key documents: `current` (service health), `queues` (queue health).

---

### `incident_log/{docId}`

Auto-generated incidents from health checks.

| Field | Type | Description |
|---|---|---|
| `source` | string | `health-check` \| `queue-monitor` |
| `service` | string | Service name (health-check) |
| `queue` | string | Queue name (queue-monitor) |
| `error` | string | Error message |
| `failedCount` | number | Failed job count (queue-monitor) |
| `severity` | string | `warning` \| `critical` |
| `ts` | timestamp | Detection timestamp |
| `resolved` | boolean | Whether resolved |

**Indexes:** `source` + `ts` desc

---

### `notification_log/{docId}`

Sent notification records.

**Indexes:** `type` + `sentAt` desc, `channel` + `sentAt` desc

---

### `spei_log/{docId}`

SPEI transfer records.

**Indexes:** `loanId` + `disbursedAt` desc

---

### `payment_failures/{docId}`

Failed payment attempts.

**Indexes:** `loanId` + `ts` desc

---

### `ml_decisions/{docId}`

ML model decision records.

**Indexes:** `type` + `decidedAt` desc

---

### `scheduler_runs/{docId}`

Scheduled job execution logs.

| Field | Type | Description |
|---|---|---|
| `job` | string | Job name (e.g., `dailyLoanCheck`) |
| `ranAt` | timestamp | Execution time |
| `overdueFound` | number | Count (for dailyLoanCheck) |
| `status` | string | `complete` |

---

### Other Collections

| Collection | Purpose | Access |
|---|---|---|
| `contact/{docId}` | Public contact form submissions | Public create, admin read |
| `notification_queue/{docId}` | Internal notification queue | Admin SDK only |
| `softcredito_employers/{docId}` | SoftCredito employer registrations | Admin read only |

---

## Relationships

```
employers/{employerId}
  ├── employees (via employees.employerId)
  └── loans (via loans.employerId)

employees/{employeeId}
  └── loans (via loans.employeeId)

loans/{loanId}
  ├── disbursement_queue (via disbursement_queue.loanId)
  ├── repayments (via repayments.loanId)
  ├── overdue_log (via overdue_log.loanId)
  ├── spei_log (via spei_log.loanId)
  └── payment_failures (via payment_failures.loanId)
```

## Registry & Ledger (Postgres, additive)

A small Postgres database on Railway (`db/registry/`) sits alongside Firestore — additive only,
nothing above is migrated away. It holds:

| Table | Purpose |
|---|---|
| `entities` | One durable UUID per real-world thing (worker, employer, agent, loan, ...) |
| `entity_refs` | Maps external IDs (CURP, RFC, IMSS NSS, firebase uid, CLABE, ...) to one `entities.id` |
| `relationships` / `relationship_members` | N-ary facts (e.g. a credit decision) linking multiple entities by role |
| `receipts` | Append-only, hash-chained ledger — one row per consequential action, `idempotency_key` is the idempotency record |
| `authority_rules` | Deny-by-default rules for the `authorize()` gate (schema only for now, not yet enforced) |

`receipts` blocks `UPDATE`/`DELETE` at the trigger level; the hash chain itself is computed by a
single writer path (`services/shared/registry/hashChain.js`) so it stays gap-free under concurrent
writers. Migrations: `cd db/registry && npm run migrate:up` (reversible via `migrate:down`).

**Identity resolution:** `services/registry-service` is the only thing that talks to this database
directly. It exposes `POST /internal/entities/resolve` (resolve-or-create an entity for a
`(system, externalId)` pair, e.g. `firebase:{uid}`) and `POST /internal/entities/:id/refs` (attach
an additional ref, e.g. an employer's `rfc` alongside their firebase uid), both gated by
`x-internal-secret` — same pattern Cloud Functions already use to call `underwriting-service` and
`softcredito-adapter`. Calls from `functions/` are shadow-write only right now: best-effort, wrapped
in try/catch, never block or fail the real Firestore operation. `services/registry-service/scripts/backfill.js`
seeds the registry from existing `employers/{uid}` docs (dry-run and apply modes).

Not yet backfilled: workers/employees. Funpay currently writes employee data to two different
Firestore shapes (`employees/{uid}` flat vs `employers/{id}/employees/{docId}` subcollection) —
that needs reconciling first so one real worker doesn't become two registry entities.

---

## Security Model

- **Firestore Security Rules** enforce client-side access (see `firestore.rules`)
- **All writes to loans, audit_log, and operational collections** go through Cloud Functions via Admin SDK (bypasses rules)
- **Employees** can read/update limited fields on their own documents
- **Employers** can read employees that belong to them (via `employerId` match)
- **Catch-all rule** denies access to any undocumented paths
