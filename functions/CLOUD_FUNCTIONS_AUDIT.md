# Cloud Functions Audit — VID3-339

**Date:** 2026-03-24 (original audit)
**Re-verified:** 2026-09-19 — the original count, line count, and two of the
per-function claims below were stale. Corrected inline; see the note at the
end of each corrected section for what changed and how it was checked.

**Total deployed functions:** 47 (exported from `functions/src/index.ts`,
counting re-exports from other modules — verified by grepping every
`export const … = on(Request|Call|DocumentCreated|DocumentUpdated|Schedule)(`
and every `export { … } from …` in that file on 2026-09-19)

> The original audit said "20" and described an "~885-line index.ts". Neither
> is true today: `functions/src/index.ts` is **3,974 lines**
> (`wc -l functions/src/index.ts`), and the function count below is more than
> double the original figure — largely because functions implemented in
> separate module files and re-exported from `index.ts` (e.g.
> `loans/markLoanDisbursed.ts`, `invites/*.ts`, `webhooks/metamap.ts`) were
> undercounted or omitted in the original pass.

## Deployed Functions

### onRequest (2)

| # | Function | Source |
|---|----------|--------|
| 1 | `api` | index.ts |
| 2 | `metamapWebhook` | webhooks/metamap.ts (re-exported via webhooks/index.ts) |

### onCall (33)

| # | Function | Source |
|---|----------|--------|
| 1 | `checkEmailAvailability` | index.ts |
| 2 | `validateCURP` | index.ts |
| 3 | `getLoanConfig` | index.ts |
| 4 | `requestLoan` | index.ts |
| 5 | `updateLoanStatus` | index.ts |
| 6 | `approveEmployer` | index.ts |
| 7 | `getPortfolioReport` | index.ts |
| 8 | `getAdminDashboard` | index.ts |
| 9 | `getEmployerDashboard` | index.ts |
| 10 | `submitReviewDecision` | index.ts |
| 11 | `getReviewDetail` | index.ts |
| 12 | `updateEmployerTier` | index.ts |
| 13 | `setEmployerClaims` | index.ts |
| 14 | `updateEmployerCurpConfig` | index.ts |
| 15 | `submitEmployerDocs` | index.ts |
| 16 | `submitPayrollDeductionSetup` | index.ts |
| 17 | `ensureEmployerCode` | index.ts |
| 18 | `markLoanDisbursed` | loans/markLoanDisbursed.ts |
| 19 | `getContractDownloadUrl` | loans/getContractDownloadUrl.ts |
| 20 | `generatePaymentLink` | payments/generatePaymentLink.ts |
| 21 | `setAdminClaim` | admin/adminClaims.ts |
| 22 | `revokeAdminClaim` | admin/adminClaims.ts |
| 23 | `getSystemHealth` | admin/getSystemHealth.ts |
| 24 | `getReviewQueue` | admin/getReviewQueue.ts |
| 25 | `sendVerificationEmail` | auth/sendVerificationEmail.ts |
| 26 | `sendEmployeeInvite` | invites/sendEmployeeInvite.ts |
| 27 | `lookupInvite` | invites/lookupInvite.ts |
| 28 | `acceptInvite` | invites/acceptInvite.ts |
| 29 | `lookupEmployerByCode` | employers/lookupEmployerByCode.ts |
| 30 | `proposeLoanConfigChange` | config/loanConfigAdmin.ts |
| 31 | `approveLoanConfigChange` | config/loanConfigAdmin.ts |
| 32 | `processPayroll` | payroll/processPayroll.ts |
| 33 | `refreshSatBlacklists` | scheduled/satBlacklistRefresh.ts |

### onDocumentCreated (5)

| # | Function | Trigger Path | Source |
|---|----------|-------------|--------|
| 1 | `onEmployerDocCreated` | `employers/{uid}` | index.ts |
| 2 | `onEmployeeDocCreated` | `employees/{uid}` | index.ts |
| 3 | `autoVerifyOnEmployerCreate` | `employers/{uid}` | index.ts |
| 4 | `autoVerifyOnEmployeeCreate` | `employees/{uid}` | index.ts |
| 5 | `onContactCreated` | `contact/{docId}` | contact/onContactCreated.ts |

### onDocumentUpdated (2)

| # | Function | Trigger Path | Source |
|---|----------|-------------|--------|
| 1 | `onLoanStatusChange` | `loans/{loanId}` | index.ts |
| 2 | `onLoanApproved` | `loans/{loanId}` | index.ts |

### onSchedule (5)

| # | Function | Schedule | Source |
|---|----------|----------|--------|
| 1 | `weeklyPortfolioSnapshot` | `0 8 * * 1` (Mon 8am MX) | index.ts |
| 2 | `systemHealthCheck` | `*/5 * * * *` (every 5 min) | index.ts |
| 3 | `queueHealthCheck` | `*/2 * * * *` (every 2 min) | index.ts |
| 4 | `dailyLoanCheck` | `0 9 * * *` (daily 9am MX) | scheduled/dailyLoanCheck.ts |
| 5 | `satBlacklistRefresh` | — | scheduled/satBlacklistRefresh.ts |

### Not deployed (disabled)

- **`autoVerifyTestAccounts`** — the original audit listed this as deployed
  ("Auth trigger (v1)"). It is not: the `export` is commented out at
  `functions/src/index.ts:187` with the note "DISABLED: requires Identity
  Platform (GCIP)". It is dead code, not a live function, and is excluded
  from the total above.

## Spec Comparison

The two items the original audit listed as "missing from spec" are both
implemented today:

- **`onEmployerDocCreated`** — previously marked "not implemented". It is
  implemented, as an `onDocumentCreated('employers/{uid}', …)` trigger at
  `functions/src/index.ts:2824`.
- **`setEmployerClaims`** — previously marked "not implemented (have
  `setAdminClaim`/`revokeAdminClaim` instead)". It is now also implemented,
  as a distinct `onCall` at `functions/src/index.ts:2930` (retroactively sets
  `employer_admin` custom claims).

The rest of the original spec-comparison breakdown (which functions are
"present", "extra", or spec-required) was not re-derived against the source
spec document in this pass — only the two claims above were checked, because
those are the ones known to be false. Treat the remaining present/extra
counts as unverified rather than re-asserting the old "11/13" total, which
no longer accounts for the fuller function list above.

## Notable Findings

1. **Duplicate code**: Many functions implemented in both `index.ts` and separate module files. Only index.ts versions deploy. Module refactor is incomplete.
2. **Un-deployed modules**: `submitContactForm` and `getEmployeeDashboard` exist as files but are not exported from index.ts (verified 2026-09-19: still no reference to either name in `functions/src/index.ts`).
3. **Dual triggers**: Both `onLoanStatusChange` and `onLoanApproved` fire on every `loans/{loanId}` update.
4. **Large index.ts**: `functions/src/index.ts` is 3,974 lines of inline business logic plus re-exports (not ~885 — see note at top).
5. **Auth inconsistency**: `autoVerifyTestAccounts` was the only v1-API trigger; it is now disabled entirely (commented out), so every currently-deployed function uses the v2 API.
