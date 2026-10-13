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

/** HTTP 401 from requestLoan: App Check or the ID token was not accepted */
export const unauthenticated = new Counter('unauthenticated_requests');

/** FAILED_PRECONDITION from requestLoan: the uid already has an open loan, or another business rule refused it */
export const refusedPrecondition = new Counter('refused_precondition_requests');

/**
 * INVALID_ARGUMENT from requestLoan. For a pool member this is nearly always
 * "El monto excede tu crédito disponible": the member was already used, its
 * open loan holds the credit, and the credit check runs BEFORE the open-loan
 * guard — so a reused member answers this or DUPLICATE_LOAN_APPLICATION
 * depending on how much of its line the first loan took (seen on the emulator
 * run of 2026-10-13: 3 of 8 reused members).
 */
export const refusedInvalidArgument = new Counter('refused_invalid_argument_requests');

/** Any other failed request (none of the above, nor 429 / timeout / 5xx) */
export const otherFailures = new Counter('other_failed_requests');

/** Pool sign-ins that did not return an ID token (the requestLoan that follows is a 401) */
export const signInFailures = new Counter('auth_sign_in_failures');

// ── System gauges ───────────────────────────────────────────────────────────

/** Current request rate (tracked per reporting interval) */
export const currentRPS = new Gauge('current_requests_per_sec');

/** Active virtual users */
export const activeVUs = new Gauge('active_virtual_users');
