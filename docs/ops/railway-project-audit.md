# Railway projects — which is FunPay's

Last reviewed: 2026-09-17 · Owner: Isaac

## TL;DR

**All FunPay services run in one Railway project: `observant-miracle` / `production`**
(ID `1ad040b4-6f0b-4530-9f58-0a1ef5e89c75`; renaming it to "FunPay" changes no ID, token,
domain or private hostname). `vida-backend` is **Funtrip's** project — do not deploy FunPay
services there, and do not operate Funtrip's services from FunPay work.

| Service | Project | Deployed by |
|---|---|---|
| payment-server, softcredito-adapter, notification-service, pdf-generator, ml-service, underwriting-service, Redis | `observant-miracle` | Railway / `deploy.yml` |
| registry-service-funpay + registry-ledger-db | `observant-miracle` (since 2026-09-17) | `deploy-registry-funpay.yml` |

## History

The April 2026 version of this file described `vida-backend` as a possibly stalled FunPay
migration. It was not: `vida-backend` became Funtrip's backend (booking-engine, api,
reconciler, scrapers, its own registry-service). The one FunPay service that lived there,
`registry-service-funpay` with its database `registry-ledger-db`, moved into
`observant-miracle` on 2026-09-17:

- New database created (Postgres 17, own volume); the ledger (schema + migration history;
  0 entities at the time) copied with `pg_dump`/`pg_restore` and verified identical
  (tables, columns, indexes, triggers, functions, row counts).
- New service deployed from `main`, `/health` reporting `db: true`, internal-secret gate
  verified; `REGISTRY_SERVICE_URL` switched to
  `https://registry-service-funpay-production-1d23.up.railway.app`.
- The old copy in `vida-backend` stays in place, untouched, as the rollback path until it is
  explicitly retired (then also remove `RAILWAY_TOKEN_VIDA_BACKEND` from this repo).
