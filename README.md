# VIDA Finance (FunPay)

Payroll-deducted lending for Mexican employees: employers enroll, employees
borrow against verified income, repayment happens through payroll deductions
(SoftCrédito) and card payments (Conekta), disbursement over SPEI.

## Architecture in one paragraph

A React 19/Vite app (`public-v2/`) on Firebase Hosting talks to ~27 Firebase
Cloud Functions (`functions/`) over callable/HTTP endpoints, with Firestore as
the system of record (flat collections — see [DATABASE.md](DATABASE.md)).
Money movement and heavy lifting live in Railway microservices (`services/`):
payment-server, softcredito-adapter, notification-service, pdf-generator,
ml-service (Python underwriting models, shadow-gated per ADR-001),
underwriting-service (7-stage credit pipeline: Belvo, MetaMap, RiskSeal) and
registry-service (Postgres hash-chain ledger), sharing a Redis for BullMQ
queues. Full map, URLs and env contracts: [SERVICES.md](SERVICES.md).

## Verify before you trust anything

| Question | Command / place |
|---|---|
| Does the code pass its gates? | CI (`.github/workflows/ci.yml`) — every suite is a hard gate |
| Functions suite locally | `cd functions && npm ci && npx tsc --noEmit && npx jest` |
| Frontend locally | `cd public-v2 && npm ci --legacy-peer-deps && npm run lint && npm test && npm run build` |
| Rules tests (needs emulators) | `npm ci && npm run test:rules` |
| Is production actually alive? | `node scripts/check-production-health.mjs`, and the scheduled `verify-production-live.yml` workflow |
| Launch readiness | [docs/LAUNCH_CHECKLIST_v1.8.md](docs/LAUNCH_CHECKLIST_v1.8.md) — every claim carries the command that proves it |

Canonical production URLs live in
[`scripts/production-endpoints.json`](scripts/production-endpoints.json) —
edit them there, nowhere else.

## Where the decisions live

- [docs/adr/](docs/adr/) — the nine ratified ADRs (fee-rate single source of
  truth, auto-approve gate policy, slot accrual ledger, ML shadow mode, …).
- [docs/runbooks/](docs/runbooks/) — incident response, deploys, alerting,
  provider failover, uptime monitoring.
- [DATABASE.md](DATABASE.md) — Firestore data model.
- [SETUP.md](SETUP.md) — local development setup.

## Ground rules

- This is a money product. `ALLOW_STUB_DISBURSEMENT=true` exists for
  local/dev/test only; a failed SPEI transfer marks a loan
  `disbursement_failed`, never `active`.
- There is currently **no live staging environment** (see SERVICES.md,
  "Staging — honest status"). Don't let a green `verify-staging.sh` from
  before 2026-09 fool you — it used to probe production.
- A tick with no evidence and no date is not done (LAUNCH_CHECKLIST v1.8's
  founding rule).
