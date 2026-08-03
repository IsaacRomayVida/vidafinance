# Architecture Decision Records

Decisions that govern how this system behaves and that a future reader would otherwise
have to reverse-engineer from a diff. An ADR is a record, not a plan: once ACCEPTED the
text is not edited to match later reality — a decision that changes gets a new ADR that
supersedes the old one.

ADR-001 through ADR-004 were written outside the repository and lived in an agent
workspace, which is why four source files pointed at an `outputs/` path that no clone
ever contained (ADR-005, Finding 0). They are in-tree as of this commit; a decision that
governs the code belongs beside it.

| # | Title | Status | Governs |
|---|---|---|---|
| [001](ADR-001-ml-shadow-mode-gate.md) | ML models run shadow-only until empirically validated | ACCEPTED | `services/ml-service`, the underwriting decision path |
| [002](ADR-002-fee-rate-single-source-of-truth.md) | Fee rate: 30%, behind a single server-side source of truth | ACCEPTED — ratified by Isaac 2026-08-02 | `functions/src/config/loanConfig.ts`, all borrower pricing |
| [003](ADR-003-lending-slot-autoscale-not-implemented.md) | Lending-slot auto-scaling stays unimplemented; CI gate goes hard around it | SUPERSEDED by ADR-007 | `services/underwriting-service`, `ci.yml` |
| [004](ADR-004-underwriting-worker-not-the-decision-path.md) | Retire the 11 decision-engine tests in `underwriting_worker` | ACCEPTED | `services/ml-service/workers`, `pytest.ini` |
| [005](ADR-005-underwriting-spec-vs-implementation-reconciliation.md) | Reconciling the underwriting spec with the underwriting implementation | ACCEPTED (engineering); C1/C2 answered by ADR-007, C3 by ADR-006, C4 open | Stage 3 auto-approve gate, employer slots |
| [006](ADR-006-auto-approve-gate-policy-ratified.md) | The Stage 3 auto-approve gate policy, ratified | ACCEPTED — ratified by Isaac 2026-08-03; implemented, C4 still open | Stage 3 auto-approve gate |
| [007](ADR-007-lending-slot-hybrid-growth.md) | Lending-slot hybrid growth: +10 per clean cycle, credited at review, capped at 2 per review | ACCEPTED — ratified by Isaac 2026-08-03 | `services/underwriting-service/src/stages/employer-b.js`, `src/config/lendingSlotGrowth.js` |

## Open commercial questions

ADR-005 separates what engineering may settle from what only the founder may. Of its five
commercial questions — C1–C5, covering slot increments, slot constants, the P(default)
cutoff, which conditions gate auto-approval, and whether a competitor loan blocks — **three
are now closed**: C5 in ADR-005 itself and #472 (a competitor loan blocks auto-approval
only, never declines), C3 by [ADR-006](ADR-006-auto-approve-gate-policy-ratified.md)
(cutoff 0.15), and C1 plus the increment/cap/ceiling portion of C2 by
[ADR-007](ADR-007-lending-slot-hybrid-growth.md).

**C4 remains open**, along with the remainder of C2 (Tier-2 bands, upgrade cycles, tier
thresholds). C4 asks whether `no_active_defaults` and `age_range` should retire now that
días de atraso and cartera vencida are read directly. ADR-006 §2 records why it was
withdrawn from the closed list: retiring a condition loosens the gate, and Isaac never
ruled on it — his only words on it were "explain question four, I don't get it". Until he
rules, the gate runs twelve conditions rather than ten. Nothing in the engineering list
waits on these, and no one implementing from these ADRs should decide one by picking a
default.

ADR-006 is implemented as of this branch. Note that ADR-006 §"The finding that limits all
of the above" still records why the ratified cutoff binds less than it appears to until
the ML response contract is fixed.
