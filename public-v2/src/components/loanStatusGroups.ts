/**
 * Loan status → timeline-group mapping used by `LoanStatusCard`.
 *
 * Split out of LoanStatusCard.tsx (a component file) rather than exported
 * from it directly: `react-refresh/only-export-components` is a hard lint
 * gate in this repo (`npm run lint` in CI), and it rejects a component file
 * that also exports plain constants/functions. Kept as its own module so
 * `loanStatusCoverage.test.ts` can import `resolveGroup`/`GROUP_COLORS`
 * without pulling in the component itself, and so the mapping stays testable
 * in isolation of anything React-specific.
 */

export type StatusGroup =
  | 'pending_review'
  | 'approved'
  | 'disbursing'
  | 'active'
  | 'repaid'
  | 'denied'
  | 'escalated'
  | 'other';

export function resolveGroup(status: string): StatusGroup {
  switch (status) {
    case 'pending':
    case 'under_review':
      return 'pending_review';
    case 'approved':
      return 'approved';
    case 'disbursement_queued':
    case 'disbursed':
      return 'disbursing';
    case 'active':
    case 'overdue':
      return 'active';
    case 'paid':
    case 'repaid':
    case 'completed':
      return 'repaid';
    // `rejected_ml` (ML auto-rejection) shares the rejected card and copy
    // verbatim — the ML-vs-human distinction is an internal audit fact, not
    // something the borrower needs surfaced.
    case 'rejected':
    case 'rejected_ml':
      return 'denied';
    case 'escalated':
      return 'escalated';
    // `disbursement_failed`, `cancelled`, `in_collections` and `written_off`
    // deliberately fall through to 'other' rather than being folded into a
    // neighbouring group: every existing card asserts something that is false
    // for them (the disbursing card promises "los fondos llegarán en minutos",
    // the denied card shows a rejection reason and a re-apply cooldown, the
    // repaid card congratulates). 'other' states the status and nothing else
    // until Funpay Design supplies real card copy for each. Previously these
    // hit `default: 'pending_review'`, which told a written-off borrower their
    // application was under review and drew a pending timeline.
    default:
      return 'other';
  }
}

export const GROUP_COLORS: Record<StatusGroup, { bg: string; accent: string; text: string }> = {
  pending_review: { bg: 'var(--warning-bg)', accent: '#d4a017', text: 'var(--warning-text)' },
  approved:       { bg: 'var(--info-bg)', accent: 'var(--info)', text: 'var(--info-text)' },
  disbursing:     { bg: 'var(--info-bg)', accent: 'var(--info)', text: 'var(--info-text)' },
  active:         { bg: '#e8f6f6', accent: 'var(--brand)', text: 'var(--brand)' },
  repaid:         { bg: 'var(--success-bg)', accent: 'var(--brand-light)', text: 'var(--success-text)' },
  denied:         { bg: 'var(--danger-bg)', accent: 'var(--danger)', text: 'var(--danger-text)' },
  escalated:      { bg: 'var(--warning-bg)', accent: '#d4a017', text: 'var(--warning-text)' },
  // Neutral grey, matching the .badge-written_off / .badge-cancelled values
  // already in legacy.css — no new palette invented for the interim card.
  other:          { bg: '#f0f0f0', accent: '#666', text: '#444' },
};
