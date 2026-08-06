// The one place that decides what a condition's `source` means.
//
// `source` was added by #458/#459 and is only "read"/"assumed" going forward
// (services/underwriting-service/src/stages/stage3-autoapprove.js writes one or
// the other on all 12 conditions). Loans written before that PR have no `source`
// key at all — that is silence, not an outage signal, so it gets its own
// "unknown" state rather than being folded into "assumed". Collapsing it into
// "assumed" would tell ops a legacy loan was escalated by a provider outage when
// the pipeline simply predates provenance tracking, which is a fabricated claim
// about data it never had.
//
// This lives in its own module because two screens now render it — the queue's
// `unreadFailures` summary (getReviewQueue) and the detail panel's per-condition
// rows (getReviewDetail, E5c). Two copies of the rule would be free to drift,
// and the first drift is silent: the same loan would read "provider outage" on
// one screen and "legacy" on the other, with nothing failing.
export type ConditionSource = 'read' | 'assumed' | 'unknown';

export function conditionSource(raw: unknown): string {
  return typeof raw === 'string' ? raw : 'unknown';
}
