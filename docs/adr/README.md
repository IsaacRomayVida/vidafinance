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
| [003](ADR-003-lending-slot-autoscale-not-implemented.md) | Lending-slot auto-scaling stays unimplemented; CI gate goes hard around it | ACCEPTED | `services/underwriting-service`, `ci.yml` |
| [004](ADR-004-underwriting-worker-not-the-decision-path.md) | Retire the 11 decision-engine tests in `underwriting_worker` | ACCEPTED | `services/ml-service/workers`, `pytest.ini` |
| [005](ADR-005-underwriting-spec-vs-implementation-reconciliation.md) | Reconciling the underwriting spec with the underwriting implementation | ACCEPTED (engineering); five commercial questions open | Stage 3 auto-approve gate, employer slots |

## Open commercial questions

ADR-005 separates what engineering may settle from what only the founder may. Its five
commercial questions — C1–C5, covering slot increments, slot constants, the P(default)
cutoff, which ten conditions gate auto-approval, and whether a competitor loan blocks —
are unanswered. Nothing in the engineering list waits on them, and no one implementing
from these ADRs should decide one by picking a default.
