# VIDA Finance Launch Checklist v1.8

> **Last measured:** 2026-08-03 against `main` @ `4581cd6`
> **Status:** partially verified — see the two tables below. **Not signed off.**
>
> ### Why this file replaces `LAUNCH_CHECKLIST_v1.7.md`
>
> v1.7 was dated 2026-03-21 and declared **"Status: All items verified"**, with every one of its
> ~30 boxes ticked. On 2026-08-02 an audit of the same tree found eight defects, two of them P0:
> every loan request was rejected with `Plazo inválido`, and borrowers were quoted an 8% fee and
> charged 30% (`outputs/CRITICAL_DEFECTS.md`). A document asserting a green loan wizard while the
> loan wizard could not complete a single request is worse than no document — it is a sign-off
> surface for a launch that would have failed on first contact with a borrower.
>
> The defect was not the ticks being wrong on the day. It is that **a tick carries no evidence and
> no date**, so it cannot be re-checked and never expires. v1.8 fixes the format, not just the
> values:
>
> - Every claim this repo can prove carries **the command that proves it** and the date measured.
> - Every claim the repo *cannot* prove is moved to a second table and named as needing a human.
>   It is not ticked here, by anyone, ever.
> - A claim with no evidence column is not "unknown"; it is **not done**.
>
> Re-measure before any launch sign-off. If the date above is stale, this file is a hypothesis.

---

## A. Machine-verified — evidence attached

Measured 2026-08-03 against `4581cd6`. Reproduce with the command in the evidence column.

| # | Item | State | Evidence |
|---|---|---|---|
| A1 | Full CI green on `main` | ✅ | Run `30798414583` — **10/10 jobs**, incl. both HARD gates (Firestore Rules, Loan Flow E2E). `gh run view 30798414583` |
| A2 | Production deploy succeeds | ✅ | Run `30798414554` — functions, rules, indexes, hosting all `Deploy complete!`. First fully green deploy since 2026-07-31 (see D1) |
| A3 | ESLint + TypeScript zero errors | ✅ | CI job *Lint, Typecheck & Test* + *Frontend Lint, Typecheck & Build*, both green in `30798414583` |
| A4 | Unit / integration / rules tests pass | ✅ | CI `30798414583`; `functions` suite 431/431 local at `361b09c` |
| A5 | No `continue-on-error` in CI — every suite is a hard gate | ✅ | `grep -n continue-on-error .github/workflows/ci.yml` → 2 hits, **both comments forbidding it**, zero directives |
| A6 | Zero references to Truora / Incode / Sardine / EFL in shipped code | ✅ | `grep -rniE "truora\|incode\|sardine\|\bEFL\b" services/ functions/src/ public-v2/src/` → 2 hits, both in `ml-service/tests/test_prompt_loader.py` asserting their **absence**. The guard is the only mention |
| A7 | The 8 P0/P1/P2 defects of 2026-08-02 are fixed | ✅ | `outputs/CRITICAL_DEFECTS.md` audit table, re-verified against source 2026-08-03T01:30Z; P0-1 and P0-2 re-read again this pass |
| A8 | Loan pricing has one server-side source of truth | ✅ | `functions/src/index.ts:395,449,657` all read `loanConfig.feeRate`; `feeRate` frozen onto the loan at creation so a later config change cannot reprice a signed loan. ADR-002 |
| A9 | Stage-3 auto-approve breakdown persisted for ops | ✅ | `functions/src/index.ts:608-638` writes `underwritingDecision` (decision, reason, allPass, all 10 conditions with value/bound/source). Fail-soft: omitted, never blocking |
| A10 | Every service exposes `/health` | ✅ | 7/7: payment-server, softcredito-adapter, notification-service, pdf-generator, ml-service, underwriting-service, registry-service |

---

## B. Not verifiable from this repo — needs a named human

These were **all ticked in v1.7 with no evidence**. Nothing in the repo can confirm them: they are
live-infrastructure and third-party facts. They are listed unticked on purpose.

| # | Item | Owner | Why the repo cannot answer it |
|---|---|---|---|
| B1 | Production env vars set (MetaMap, Belvo, SoftCrédito, RiskSeal) | Isaac / ops | Values live in Railway + GitHub secrets, never in-tree |
| B2 | All internal service secrets rotated off staging values | Isaac / ops | A secret's *value* is invisible here; only its *presence* is enforced (boot-time `throw`, P1-4) |
| B3 | MetaMap webhook secret is the production value | Isaac / ops | Same as B2 |
| B4 | Redis memory limit configured (OOM guard) | Isaac / ops | Railway runtime config |
| B5 | Firestore write quota raised above the 500/sec default | Isaac / ops | GCP quota console |
| B6 | Hosting traffic split (90% React / 10% legacy) | Isaac / ops | Firebase Hosting runtime config |
| B7 | Alerting rules configured **and a test alert delivered** | Isaac / ops | Delivery is observable only in the alert sink |
| B8 | Load test passed at 2x target throughput | Isaac / ops | No load-test artifact committed. If one exists, commit the report and promote this to table A |
| B9 | Lighthouse ≥90 on marketing pages | Isaac / ops | Not run in CI. Cheap to automate — see D3 |
| B10 | The 5 live Railway services actually return 200 | Isaac / ops | A10 proves the route **exists in code**; only prod proves it **answers**. Do not conflate these — v1.7 did |
| B11 | Champion/challenger/autoencoder models deployed; PSI-CSI baselines saved | Isaac / ops | Model registry state is external. `docs/ML_MODEL_STATUS.md` is the closest in-tree record |

---

## C. Sign-off

No signature until **table A is re-measured on the release commit** and **every row of table B is
initialled by its owner**. A blank cell is "not done", never "assumed fine" — that assumption is
precisely what v1.7 encoded.

| Role | Name | Date | Commit measured | Signature |
|------|------|------|-----------------|-----------|
| Engineering Lead | | | | |
| Product Owner | | | | |
| Compliance Officer | | | | |
| QA Lead | | | | |

---

## D. Open gaps found while measuring

**D1 — The deploy blocker cleared itself; nobody would have noticed.**
Production deploys failed for ~3 days on an HTTP 403 write refusal. Run `30798414554` (2026-08-03
08:42Z) shows the preflight canary getting **200** and the full deploy landing. No config change
was made on our side, so the fix was upstream — billing or IAM. Worth confirming *which*, because
an unexplained recovery can un-recover. The preflight canary itself is the win: it aborts before
any partial write, so three days of failure changed nothing in prod.

**D2 — Launch monitoring covers 5 services; 7 exist, and the 2 omitted are the important ones.**
v1.7 monitors payment-server, softcredito-adapter, notification-service, pdf-generator, ml-service.
Absent: **underwriting-service** (makes the credit decision) and **registry-service** (holds the
ledger). Both expose `/health`. A product that cannot underwrite is down even if all five monitored
services are green. Add both to health checks and alerting before launch.

**D3 — Lighthouse and load-test claims have no CI home.**
B8 and B9 were ticked in v1.7 and are unfalsifiable as written. Either add a CI job (Lighthouse CI
is a small addition to the frontend job) or commit the report artifact. Until then they stay in B.

**D4 — 11 `console.log` calls remain in services; v1.7 claimed zero.**
Most are benign process-start banners (`listening on ${PORT}`) or a CLI backfill script. Two are
not: `pdf-generator/index.js:285` logs a per-loan signing event (`loanId`, `metamapDocumentId`) on
a request path, and `shared/health-monitor.js:154-161` logs every poll. Both bypass the structured
logger, so they carry no correlation id and are not queryable — the two properties that make a log
useful during an incident. Low severity, but the v1.7 claim of zero was false.

**D5 — Two audit-log collections still coexist.**
Noted as residual in `CRITICAL_DEFECTS.md` P2-2. Not a defect — the security-critical grant path
audit-logs before minting a claim, and a failed audit write aborts the grant. Consolidation is
cleanup; worth doing before launch so incident forensics has one place to look.
