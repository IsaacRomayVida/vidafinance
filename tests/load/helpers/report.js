/**
 * Pieces of the k6 summary report that decide what the report CLAIMS. Pure —
 * no k6 imports — so tests/load/seed/pool.test.mjs runs them under node.
 */

const STAGE_TRENDS = [
  ['Validation', 'stage_latency_validation'],
  ['Firestore Write', 'stage_latency_firestore_write'],
  ['Queue Dispatch', 'stage_latency_queue_dispatch'],
  ['ML Scoring', 'stage_latency_ml_scoring'],
];

/**
 * Body lines of the "Per-Stage Latency" box. A stage is printed only when its
 * trend holds samples, and those come from the target's X-Stage-*-Ms response
 * headers alone. With none, the box says so instead of standing empty (or, as
 * it once did, showing fixed fractions of the total as if they were measured).
 *
 * @param {Record<string, { values?: Record<string, number> }>} metrics  `data.metrics` of handleSummary
 * @returns {string[]}
 */
export function stageLatencyLines(metrics) {
  const lines = [];
  for (const [name, key] of STAGE_TRENDS) {
    const metric = metrics[key];
    if (metric && metric.values && metric.values.count > 0) {
      const p95 = (metric.values['p(95)'] || 0).toFixed(0);
      const p50 = (metric.values['p(50)'] || 0).toFixed(0);
      lines.push(`│  ${name.padEnd(20)} P50: ${p50.padStart(6)}ms  P95: ${p95.padStart(6)}ms`);
    }
  }
  if (lines.length === 0) {
    lines.push('│  not instrumented — the target sends no X-Stage-*-Ms headers,');
    lines.push('│  so only the end-to-end latency above was measured');
  }
  return lines;
}

/**
 * Path, without extension, of one run's result files. The time of day is part
 * of the name: with the date alone, a second run on the same day silently
 * replaced the first one's report — including a committed one.
 *
 * @param {string} timestamp  ISO 8601, e.g. 2026-10-13T14:22:33.123Z
 * @param {string} label      emulator | staging | production
 * @param {string} profile    smoke | full
 */
export function resultsBaseName(timestamp, label, profile) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(timestamp);
  if (!m) throw new Error(`Not an ISO timestamp: ${timestamp}`);
  return `tests/load/results/${m[1]}T${m[2]}${m[3]}${m[4]}Z-${label}-${profile}`;
}
