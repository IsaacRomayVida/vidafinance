/**
 * Custom k6 metrics for per-stage latency tracking and pipeline monitoring.
 */

import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

// ── Per-stage latency trends ────────────────────────────────────────────────

/** End-to-end latency: request sent → response received */
export const requestLatency = new Trend('request_latency_e2e', true);

/** Validation stage (input parsing, auth check) */
export const stageValidation = new Trend('stage_latency_validation', true);

/** Firestore write stage (loan document creation + transaction) */
export const stageFirestoreWrite = new Trend('stage_latency_firestore_write', true);

/** Queue dispatch stage (BullMQ job enqueue) */
export const stageQueueDispatch = new Trend('stage_latency_queue_dispatch', true);

/** ML scoring stage (if synchronous call included) */
export const stageMlScoring = new Trend('stage_latency_ml_scoring', true);

// ── Throughput counters ─────────────────────────────────────────────────────

/** Total loan applications submitted */
export const loansSubmitted = new Counter('loans_submitted');

/** Total successful loan submissions */
export const loansSucceeded = new Counter('loans_succeeded');

/** Total failed loan submissions */
export const loansFailed = new Counter('loans_failed');

/** Loans by profile type */
export const loansGoodProfile = new Counter('loans_profile_good');
export const loansMediumProfile = new Counter('loans_profile_medium');
export const loansRiskyProfile = new Counter('loans_profile_risky');

// ── Error tracking ──────────────────────────────────────────────────────────

/** Error rate (failures / total) */
export const errorRate = new Rate('loan_error_rate');

/** Rate-limited requests */
export const rateLimited = new Counter('rate_limited_requests');

/** Timeout errors */
export const timeouts = new Counter('timeout_errors');

/** Server errors (5xx) */
export const serverErrors = new Counter('server_errors');

// ── System gauges ───────────────────────────────────────────────────────────

/** Current request rate (tracked per reporting interval) */
export const currentRPS = new Gauge('current_requests_per_sec');

/** Active virtual users */
export const activeVUs = new Gauge('active_virtual_users');
