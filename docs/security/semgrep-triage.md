<!-- © Suena AG / FunPay Technologies. All rights reserved. -->

# Semgrep triage

Static-analysis pass over first-party code with Semgrep CE. Every ERROR and WARNING finding was triaged as a real issue (fixed), a false positive (narrow `// nosemgrep: <rule-id> -- reason` on the line) or an accepted risk.

## How to run the scan

```bash
semgrep scan \
  --config p/owasp-top-ten --config p/typescript --config p/nodejsscan \
  --config p/react --config p/secrets --config p/dockerfile --config p/github-actions \
  --exclude node_modules --exclude dist --exclude build --exclude graphify-out --exclude .next \
  --metrics=off --json -o /tmp/semgrep.json .
```

Semgrep only scans git-tracked files. Heavy runs go through `memgate` on the shared Mac. A suppression must name the rule id and carry a one-line reason; blanket ignores are not used.

## Counts

| | ERROR | WARNING | INFO |
|---|---|---|---|
| Before | 116 | 111 | 36 |
| After | 12 | 82 | 36 |
| After, of which workflows (CI workstream) | 12 | 75 | 0 |
| After, of which legacy `public/` (out of scope) | 0 | 7 | 0 |

Unhandled ERROR findings in the scoped code after the change: **0**. The remaining ERRORs are all in `.github/workflows` and belong to the CI workstream.

## Findings (scoped code)

Rows are grouped by rule and file; lines are the original line numbers in the scanned revision.

| Rule | Sev | File | Lines | Verdict | Fix or reason |
|---|---|---|---|---|---|
| `bypass-tls-verification` | WARNING | `functions/src/employers/approveEmployer.ts` | 84, 96 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `functions/src/invites/sendEmployeeInvite.ts` | 38 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `functions/src/utils/__tests__/redis.test.ts` | 73 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. Test asserts both paths. |
| `bypass-tls-verification` | WARNING | `functions/src/utils/queue.ts` | 32 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `functions/src/utils/redis.ts` | 12 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/notification-service/src/lib/redis.ts` | 9 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/notification-service/src/workers/notificationWorker.ts` | 85 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/payment-server/index.js` | 35 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/pdf-generator/index.js` | 44 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/shared/queues.js` | 5 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/softcredito-adapter/index.js` | 58 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/underwriting-service/index.js` | 48 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `bypass-tls-verification` | WARNING | `services/underwriting-service/src/redis-client.js` | 54 | Real | Certificate verification is now on by default for `rediss://`; opt out only with `REDIS_TLS_ALLOW_UNVERIFIED=true`. |
| `cors-misconfiguration` | WARNING | `services/payment-server/index.js` | 53 | False positive | Origin is checked against the `ALLOWED` list before the header is set; `nosemgrep` added. |
| `cors-misconfiguration` | WARNING | `services/pdf-generator/index.js` | 249 | False positive | Origin is checked against the `ALLOWED` list before the header is set; `nosemgrep` added. |
| `cors-misconfiguration` | WARNING | `services/softcredito-adapter/index.js` | 73 | False positive | Origin is checked against the `ALLOWED` list before the header is set; `nosemgrep` added. |
| `cors-misconfiguration` | WARNING | `services/underwriting-service/index.js` | 90 | False positive | Origin is checked against the `ALLOWED` list before the header is set; `nosemgrep` added. |
| `detected-bcrypt-hash` | ERROR | `functions/src/__tests__/getReviewDetail.projection.test.ts` | 95 | False positive | Synthetic hash in a test fixture; `nosemgrep` added. |
| `generic_error_disclosure` | WARNING | `public-v2/scripts/generate-images.mjs` | 179 | False positive | CLI script prints to the operator console, not to an HTTP response; `nosemgrep` added. |
| `generic_error_disclosure` | WARNING | `scripts/set-employer-claims.js` | 40 | False positive | CLI script prints to the operator console, not to an HTTP response; `nosemgrep` added. |
| `last-user-is-root` | ERROR | `services/pdf-generator/Dockerfile` | 4 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/ml-service/Dockerfile` | 15 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/notification-service/Dockerfile` | 19 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/payment-server/Dockerfile` | 20 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/registry-service/Dockerfile` | 16 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/softcredito-adapter/Dockerfile` | 23 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `missing-user` | ERROR | `services/underwriting-service/Dockerfile` | 16 | Real | Container now runs as a non-root user (`node`, `pptruser` or `app`) that owns the app tree. |
| `node_api_key` | ERROR | `services/underwriting-service/src/gov-apis.test.js` | 87 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_api_key` | ERROR | `services/underwriting-service/src/riskseal-smoke.test.js` | 41, 94 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_insecure_random_generator` | WARNING | `functions/src/index.ts` | 3182 | Real | Employer join code now uses `crypto.randomInt`; test updated. |
| `node_insecure_random_generator` | WARNING | `mobile/src/components/BrandIntro.tsx` | 72 | False positive | Cosmetic pick or log correlation id, not a security token; `nosemgrep` added. |
| `node_insecure_random_generator` | WARNING | `public/js/app.js` | 816, 818, 819, 820, 821, 822, 1086 | Not in scope | Legacy `public/` site is outside this workstream; see "Open items". |
| `node_insecure_random_generator` | WARNING | `services/underwriting-service/src/decision-engine.js` | 28 | False positive | Cosmetic pick or log correlation id, not a security token; `nosemgrep` added. |
| `node_md5` | WARNING | `scripts/build-video-gallery.mjs` | 53 | False positive | Content de-duplication hash for a media gallery; `nosemgrep` added. |
| `node_password` | ERROR | `e2e-test-v18.mjs` | 15 | Real | Committed test-account password (used against the live site) removed; read from `E2E_TEST_PASSWORD`. |
| `node_password` | ERROR | `functions/src/__tests__/requestLoan.test.ts` | 2057 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `functions/src/__tests__/validateCurpFailClosed.test.ts` | 256 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `functions/src/utils/__tests__/environment.test.ts` | 37, 64, 70 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `mobile/qa-demo/seed.mjs` | 18 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `scripts/seed-remittance-emulator.mjs` | 34 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `scripts/test-employer-login.js` | 18 | Real | Committed test-account password (used against the live site) removed; read from `E2E_TEST_PASSWORD`. |
| `node_password` | ERROR | `services/underwriting-service/src/belvo-client.test.js` | 126, 221 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_password` | ERROR | `services/underwriting-service/src/stages/stage4-kyc.test.js` | 12 | False positive | Emulator-only or fixture value; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/__tests__/loanApprovalDisbursement.test.ts` | 232 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/__tests__/rateLimiterFailClosed.test.ts` | 170 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/__tests__/repaymentScheduleTruth.test.ts` | 346 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/__tests__/requestLoan.test.ts` | 585, 879, 1362, 1490, 1656 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/__tests__/validateCurpFailClosed.test.ts` | 122 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/loans/__tests__/markLoanDisbursed.test.ts` | 470 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/loans/__tests__/updateLoanStatus.test.ts` | 245 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/payments/__tests__/generatePaymentLink.test.ts` | 57, 380 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/scheduled/__tests__/dailyLoanCheck.test.ts` | 161 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/scheduled/__tests__/queueHealthCheck.test.ts` | 48 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/utils/__tests__/registryClient.test.ts` | 20 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/webhooks/__tests__/metamap.test.ts` | 8 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `functions/src/webhooks/metamap.ts` | 6 | False positive | Constant holds the environment variable name, not a secret; `nosemgrep` added. |
| `node_secret` | ERROR | `scripts/check-production-health.test.mjs` | 137, 212 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/registry-service/index.test.js` | 16, 38, 45, 53, 61, 67, 73, 87, 102, 108, 117, 121, 126, 145, 158, 162, 167, 172, 192, 198, 206, 220, 232, 259, 267, 280, 285, 293, 302, 311, 348, 365, 393 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/shared/internal-secret.test.js` | 131, 132, 138 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/softcredito-adapter/lib/internalAuth.test.js` | 17, 41, 52, 56, 102 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/async-response.test.js` | 87, 88 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/belvo-client.test.js` | 125, 126, 220, 221 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/health-build-info.test.js` | 43, 47, 48 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/metamap-client.test.js` | 58 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/stages/stage4-kyc.test.js` | 11, 12 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/webhook-metamap-unsigned.test.js` | 74, 82, 184 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_secret` | ERROR | `services/underwriting-service/src/webhook-metamap.test.js` | 69, 77, 78, 287, 325 | False positive | Test fixture value, not a credential; `nosemgrep` added. |
| `node_timing_attack` | WARNING | `services/softcredito-adapter/lib/internalAuth.test.js` | 156 | False positive | Test assertion on fixture values; `nosemgrep` added. |
| `regex_dos` | WARNING | `public-v2/src/i18n/loanStatusCoverage.test.ts` | 97 | False positive | Fixed anchored pattern, no nested quantifiers, bounded input; `nosemgrep` added. |
| `regex_dos` | WARNING | `scripts/check-deploy-watch-paths.mjs` | 284 | False positive | Fixed anchored pattern, no nested quantifiers, bounded input; `nosemgrep` added. |
| `regex_dos` | WARNING | `services/underwriting-service/src/stages/stage1-identity.js` | 53, 66 | False positive | Fixed anchored pattern, no nested quantifiers, bounded input; `nosemgrep` added. |

INFO findings (36, six `helmet_header_*` rules across six services) are not actioned: each service already calls `helmet()`, which the rule cannot see.

## Workflows (handled by the CI workstream)

Left untouched here; the files live under `.github/`.

| Rule | Sev | Count | Files |
|---|---|---|---|
| `github-actions-mutable-action-tag` | WARNING | 75 | 19 workflow files |
| `run-shell-injection` | ERROR | 12 | `.github/workflows/build-android.yml`, `.github/workflows/deploy-team-portal.yml`, `.github/workflows/deploy.yml`, `.github/workflows/generate-brand-motion.yml`, `.github/workflows/railway-setup-env.yml` |

## Behaviour notes for deployment

- **Redis TLS.** Every Redis client that used `rejectUnauthorized: false` now verifies the server certificate when the URL is `rediss://`. If a deployed environment relies on a self-signed certificate, set `REDIS_TLS_ALLOW_UNVERIFIED=true` for that service to restore the old behaviour. Plain `redis://` URLs are unaffected.
- **E2E scripts.** `e2e-test-v18.mjs` and `scripts/test-employer-login.js` now require `E2E_TEST_PASSWORD` in the environment.
- **Containers.** Services run as an unprivileged user. `ml-service` creates user `app` and owns `/app` and `/models`; `pdf-generator` uses the image user `pptruser`; the Node services use `node`. All ports are above 1024. The images could not be built locally (no Docker); CI builds them.

## Open items

- `public/js/app.js` (legacy site, outside this workstream): seven `node_insecure_random_generator` warnings. Six are confetti styling (harmless); one (`Math.random().toString(36)` for an employer code) should use `crypto.getRandomValues`.
- Workflow findings above, including `run-shell-injection` (12 ERROR) and unpinned action tags (75 WARNING).
