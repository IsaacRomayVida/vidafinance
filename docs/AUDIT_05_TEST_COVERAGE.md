# Audit 05: Unit + Integration Test Coverage Report

**Date:** 2026-03-24
**Ticket:** VID3-341

---

## Executive Summary

| Metric | Count |
|--------|-------|
| **Total test files** | 19 |
| **Total test cases** | 430 |
| **Passing** | 266 |
| **Failing** | 164 |
| **Pass rate** | 61.9% |

Most failures stem from **import/export mismatches** in underwriting-service tests — the test files reference function names that don't match the actual exports. The Cloud Functions suite and integration tests are healthy.

---

## Results by Service

### 1. Cloud Functions (`functions/`)

| Suite | Tests | Pass | Fail | Coverage |
|-------|-------|------|------|----------|
| adminClaims.test.ts | ✔ | all | 0 | 100% lines |
| approveEmployer.test.ts | ✔ | all | 0 | — |
| calculateNextPayrollDate.test.ts | ✔ | all | 0 | 100% lines |
| markLoanDisbursed.test.ts | ✔ | all | 0 | 100% lines |
| requestLoan.test.ts | ✔ | all | 0 | 100% lines |
| generatePaymentLink.test.ts | ✔ | all | 0 | 97.4% stmts |

**Total: 6 suites, 157 tests — ALL PASS**
**Line coverage: 100% | Statement coverage: 99.6% | Branch coverage: 89.3%**

### 2. Underwriting Service (`services/underwriting-service/`)

#### Jest tests (run via `npm test`)

| Suite | Tests | Pass | Fail | Root Cause |
|-------|-------|------|------|------------|
| `tests/decision-engine.test.js` | 5 | 5 | 0 | ✅ |
| `tests/metamap-client.test.js` | 3 | 3 | 0 | ✅ |
| `src/decision-engine.test.js` | — | 0 | suite | `jest.mock()` references out-of-scope variables (`incodeResult`, `sardineResult`) |
| `src/stages/__tests__/employer-a.test.js` | — | 0 | suite | `Cannot find module '../employer-a'` — wrong relative path |
| `src/stages/__tests__/employer-b.test.js` | 38 | 0 | 38 | Imports unexported helpers (`scoreSATAge`, `scoreDENUE`, `assignTier`, etc.) |
| `src/stages/__tests__/stage2-bureau.test.js` | 15 | 0 | 15 | Imports wrong names: `runStage2` (actual: `runBureauAndEmployment`), `calculateLTI` (actual: `computeLTI`) |
| `src/stages/__tests__/stage3-autoapprove.test.js` | 16 | 0 | 16 | Imports wrong names: `evaluateGate` (actual: `evaluateAutoApprove`), `runStage3` (actual: `runAutoApproveGate`) |
| `src/stages/stage4-kyc.test.js` | 2 | 2 | 0 | ✅ (runs in Jest; full suite uses `node --test`) |
| `src/stages/stage5-review.test.js` | 2 | 2 | 0 | ✅ (runs in Jest; full suite uses `node --test`) |
| `src/webhook-metamap.test.js` | — | 0 | suite | `Cannot find module 'node-fetch'` |

**Jest totals: 8 suites (1 pass, 7 fail), 116 tests — 7 pass, 109 fail**

#### Node.js native test runner (`node --test`)

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| `stage4-kyc.test.js` | 22 | 22 | 0 |
| `stage5-review.test.js` | 33 | 33 | 0 |

**Node test totals: 2 suites, 55 tests — ALL PASS**

### 3. Integration Tests (`tests/`)

| Suite | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| `integration/decision-engine.test.js` | 47 | 47 | 0 | Covers 18 decision paths end-to-end |
| `ci-workflow-audit.test.js` | 5 | 4 | 1 | Expects `FIREBASE_PROJECT_ID_PRODUCTION` in deploy step |

**Integration totals: 2 suites, 52 tests — 51 pass, 1 fail**

### 4. Firestore Rules (`firestore.rules.test.ts`)

| Suite | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| firestore.rules.test.ts | 49 | 0 | 49 | `testEnv.cleanup()` — requires Firebase Emulator running |

### 5. ML Service (`services/ml-service/`)

| Suite | Tests | Pass | Fail | Notes |
|-------|-------|------|------|-------|
| 5 test files | — | — | — | Cannot run: `bullmq==2.3.2` not available via pip; `pytest` not installed |

**Test files exist:** `test_autoencoder.py`, `test_champion_challenger.py`, `test_drift_monitor.py`, `test_prompt_loader.py`, `test_underwriting_worker.py`

---

## Decision Engine Stage Coverage

### Pipeline: Employer A → Employer B → Stage 0 → Stage 1 → Stage 2 → Stage 3 → Stage 4 → Stage 5

| Stage | Name | Unit Tests | Integration Tests | Status |
|-------|------|-----------|-------------------|--------|
| **Employer A** | Employer Screening | ❌ 0/? (import path broken) | ✅ via integration suite | Broken |
| **Employer B** | Employer Due Diligence | ❌ 0/38 (unexported helpers) | ✅ via integration suite | Broken |
| **Stage 0** | Fraud Gates | ⚠️ **No test file** | ✅ via integration suite | Missing |
| **Stage 1** | Identity Validation | ⚠️ **No test file** | ✅ via integration suite | Missing |
| **Stage 2** | Bureau & Employment | ❌ 0/15 (wrong function names) | ✅ via integration suite | Broken |
| **Stage 3** | Auto-Approve Gate | ❌ 0/16 (wrong function names) | ✅ via integration suite | Broken |
| **Stage 4** | Full KYC | ✅ 22/22 (node --test) | ✅ via integration suite | Healthy |
| **Stage 5** | AML + Manual Review | ✅ 33/33 (node --test) | ✅ via integration suite | Healthy |

**Integration coverage:** The `tests/integration/decision-engine.test.js` suite covers **all 8 stages** across 18 decision paths (47 tests, all passing). This provides end-to-end path coverage but does not exercise individual stage internals.

---

## Root Cause Analysis of Failures

### Category 1: Import/Export Mismatches (109 tests, 4 suites)
Tests were written against a different API surface than the current source code. Examples:
- `runStage2` → actual export is `runBureauAndEmployment`
- `evaluateGate` → actual export is `evaluateAutoApprove`
- `scoreSATAge`, `scoreDENUE`, etc. are private helpers, never exported

**Fix:** Update test imports to match actual exports, or export the internal helpers for testability.

### Category 2: Missing Test Files (Stage 0, Stage 1)
No unit tests exist for `stage0-fraud.js` or `stage1-identity.js`.

### Category 3: Environment Issues (50 tests, 2 suites)
- `firestore.rules.test.ts` — requires Firebase Emulator (expected in CI, not local)
- `ml-service/tests/` — Python `bullmq==2.3.2` not published to PyPI; needs Docker or pinned version bump

### Category 4: Jest Mock Scoping (1 suite)
`src/decision-engine.test.js` references variables outside `jest.mock()` factory scope (Jest 30 is stricter about this).

---

## Recommendations

1. **Fix import mismatches** in `employer-a.test.js`, `employer-b.test.js`, `stage2-bureau.test.js`, `stage3-autoapprove.test.js` — align test imports with actual module exports
2. **Fix `jest.mock()` scoping** in `src/decision-engine.test.js` — prefix variables with `mock` or move inside factory
3. **Add unit tests** for Stage 0 (Fraud Gates) and Stage 1 (Identity Validation)
4. **Fix `bullmq` version** in `ml-service/requirements.txt` — pin to an available version
5. **Add `node-fetch`** to underwriting-service devDependencies for `webhook-metamap.test.js`
6. **Standardize test runner** — Stage 4/5 use Node `test` module while others use Jest; pick one
