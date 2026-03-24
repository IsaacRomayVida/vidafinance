# Cloud Functions Audit — VID3-339

**Date:** 2026-03-24
**Total deployed functions:** 20 (exported from `functions/src/index.ts`)

## Deployed Functions

### HTTP / Callable (14)

| # | Function | Type | Auth / Roles | Source |
|---|----------|------|-------------|--------|
| 1 | `api` | onRequest | Public | index.ts |
| 2 | `requestLoan` | onCall | employee | index.ts |
| 3 | `updateLoanStatus` | onCall | employer / admin / ops | index.ts |
| 4 | `approveEmployer` | onCall | admin, super_admin | index.ts |
| 5 | `getPortfolioReport` | onCall | admin, super_admin, ops | index.ts |
| 6 | `getAdminDashboard` | onCall | admin, super_admin, ops | index.ts |
| 7 | `getEmployerDashboard` | onCall | employer (own data) | index.ts |
| 8 | `submitReviewDecision` | onCall | ops, admin, super_admin | index.ts |
| 9 | `updateEmployerTier` | onCall | ops, admin, super_admin | index.ts |
| 10 | `markLoanDisbursed` | onCall | ops, admin, super_admin | loans/markLoanDisbursed.ts |
| 11 | `generatePaymentLink` | onCall | employee | payments/generatePaymentLink.ts |
| 12 | `setAdminClaim` | onCall | admin, super_admin | admin/adminClaims.ts |
| 13 | `revokeAdminClaim` | onCall | admin, super_admin | admin/adminClaims.ts |
| 14 | `autoVerifyTestAccounts` | Auth trigger (v1) | System | index.ts |

### Firestore Triggers (2)

| # | Function | Trigger Path | Source |
|---|----------|-------------|--------|
| 15 | `onLoanStatusChange` | `loans/{loanId}` (onDocumentUpdated) | index.ts |
| 16 | `onLoanApproved` | `loans/{loanId}` (onDocumentUpdated) | index.ts |

### Scheduled (4)

| # | Function | Schedule | Source |
|---|----------|----------|--------|
| 17 | `dailyLoanCheck` | `0 9 * * *` (daily 9am MX) | index.ts |
| 18 | `weeklyPortfolioSnapshot` | `0 8 * * 1` (Mon 8am MX) | index.ts |
| 19 | `systemHealthCheck` | `*/5 * * * *` (every 5 min) | index.ts |
| 20 | `queueHealthCheck` | `*/2 * * * *` (every 2 min) | index.ts |

## Spec Comparison

### Present (11/13)

api, requestLoan, approveEmployer, markLoanDisbursed, dailyLoanCheck, weeklyPortfolioSnapshot, systemHealthCheck, queueHealthCheck, onLoanApproved, onLoanStatusChange, autoVerifyTestAccounts

### Missing from spec (2)

- **`onEmployerDocCreated`** — not implemented
- **`setEmployerClaims`** — not implemented (have `setAdminClaim`/`revokeAdminClaim` instead)

### Extra (not in spec, 9)

updateLoanStatus, getPortfolioReport, getAdminDashboard, getEmployerDashboard, submitReviewDecision, updateEmployerTier, generatePaymentLink, setAdminClaim, revokeAdminClaim

## Notable Findings

1. **Duplicate code**: Many functions implemented in both `index.ts` and separate module files. Only index.ts versions deploy. Module refactor is incomplete.
2. **Un-deployed modules**: `submitContactForm` and `getEmployeeDashboard` exist as files but are not exported from index.ts.
3. **Dual triggers**: Both `onLoanStatusChange` and `onLoanApproved` fire on every `loans/{loanId}` update.
4. **Large index.ts**: ~885 lines of inline business logic.
5. **Auth inconsistency**: `autoVerifyTestAccounts` uses v1 API; everything else uses v2.
