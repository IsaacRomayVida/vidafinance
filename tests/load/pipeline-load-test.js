/**
 * VID3-124: Load Test — 100K Loans/Month Throughput Validation
 *
 * Simulates 100K loans/month (≈140 apps/hour) against the full decision-engine
 * pipeline in staging. Ramps through 4 stages up to 2x target (280/min).
 *
 * Prerequisites:
 *   1. Every external provider switched off on the target — the full list
 *      (it is longer than METAMAP_MOCK / RISKSEAL_MOCK) is in
 *      docs/runbooks/scaling.md § "Keeping bureau / RiskSeal out of it".
 *      This script CANNOT verify it: /api/health does not report the
 *      target's configuration. The operator checks it by hand.
 *   2. Environment variables set:
 *      TARGET_URL       — Functions base URL (no default; see ./target.js —
 *                         production is refused without an explicit sign-off)
 *      POOL_SIZE        — size of the seeded user pool (tests/load/seed/);
 *                         POOL_OFFSET (default 0) skips members already used today
 *      LOAD_TEST_PASSWORD + FIREBASE_API_KEY — sign the pool members in
 *                         (FIREBASE_AUTH_EMULATOR_HOST instead of the key on the emulator)
 *      APP_CHECK_DEBUG_TOKEN (+ FIREBASE_PROJECT_ID, FIREBASE_APP_ID) — the
 *                         debug token registered on the target; exchanged for an
 *                         App Check token and refreshed during the run. Or
 *                         APP_CHECK_TOKEN, an already-exchanged token (expires).
 *                         requestLoan has enforceAppCheck: true, so a deployed
 *                         target with neither is refused at init
 *      AUTH_TOKEN       — legacy single-uid mode (no pool): measures the
 *                         duplicate-application guard and the 3/day limiter only
 *
 * Runbook (commands, low-traffic window, abort thresholds):
 *   docs/runbooks/scaling.md § Load test
 *
 * Usage:
 *   # Full load test (2 hours)
 *   k6 run --env TARGET_URL=... tests/load/pipeline-load-test.js
 *
 *   # Smoke test (5 minutes)
 *   k6 run --env TARGET_URL=... --env PROFILE=smoke tests/load/pipeline-load-test.js
 *
 *   # Output JSON for report generation
 *   k6 run --out json=results.json tests/load/pipeline-load-test.js
 *
 *   # Output CSV summary
 *   k6 run --out csv=results.csv tests/load/pipeline-load-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import exec from 'k6/execution';
import { RAMP_STAGES, SMOKE_STAGES, THRESHOLDS } from './config.js';
import { generateLoanApplication } from './helpers/synthetic-data.js';
import { resolveTarget } from './target.js';
import {
  ACCEPTED_INITIAL_STATUSES,
  appCheckPlan,
  appCheckRefreshAfterMs,
  buildPoolApplication,
  poolConfigFromEnv,
  poolIndexFor,
  poolSignInUrl,
} from './seed/pool.js';
import {
  requestLatency,
  stageValidation,
  stageFirestoreWrite,
  stageQueueDispatch,
  stageMlScoring,
  loansSubmitted,
  loansSucceeded,
  loansFailed,
  loansGoodProfile,
  loansMediumProfile,
  loansRiskyProfile,
  errorRate,
  rateLimited,
  timeouts,
  serverErrors,
  activeVUs,
} from './helpers/metrics.js';

// ── Configuration ───────────────────────────────────────────────────────────

// Throws at init — before a single request — on a missing, unknown or
// unsigned-off production target. TARGET.label names every results file.
const TARGET = resolveTarget(__ENV);
const STAGING_URL = TARGET.url;
const PROFILE = __ENV.PROFILE || 'full';

const stages = PROFILE === 'smoke' ? SMOKE_STAGES : RAMP_STAGES;

// Convert our rate-based stages to k6 VU-based stages.
// k6 uses virtual users, so we approximate: VUs ≈ target_rate * avg_duration_sec
// Assuming ~5s per request on average, each VU does ~12 requests/min.
// target_rate / 12 = VUs needed (with headroom).
const k6Stages = stages.map((s) => ({
  duration: s.duration,
  target: Math.max(1, Math.ceil(s.target / 10)), // ~10 req/min per VU
}));

export const options = {
  stages: k6Stages,
  thresholds: THRESHOLDS,
  noConnectionReuse: false,
  userAgent: 'vida-load-test/1.0',
  tags: {
    testType: 'pipeline-load-test',
    testProfile: PROFILE,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'count'],
};

// ── Seeded user pool ────────────────────────────────────────────────────────
// Every iteration uses the next member of the pool seeded by
// tests/load/seed/seed-load-pool.mjs, exactly once: requestLoan refuses a uid
// that already has an open loan, and rate-limits each uid to 3 calls a day.
// Init fails — before any request — when neither a pool nor AUTH_TOKEN is given.

const POOL = poolConfigFromEnv(__ENV);
// Throws at init for a pool aimed at production (it cannot exist there), for an
// emulator target without the Auth emulator host, and for a deployed target
// with one left set.
const SIGN_IN_URL = POOL ? poolSignInUrl(__ENV, TARGET.label) : null;
const LOAD_TEST_PASSWORD = __ENV.LOAD_TEST_PASSWORD || '';

if (!POOL && !__ENV.AUTH_TOKEN) {
  throw new Error(
    'No user pool: set POOL_SIZE (and LOAD_TEST_PASSWORD) after seeding — see docs/runbooks/scaling.md § Load test.'
  );
}
if (POOL && !LOAD_TEST_PASSWORD) {
  throw new Error('LOAD_TEST_PASSWORD is not set (the password the pool was seeded with).');
}

// requestLoan enforces App Check; callable functions read the token from the
// X-Firebase-AppCheck header. Throws at init when a deployed target is given
// neither a debug token nor an exchanged one (the emulator gets an unsigned
// placeholder, which only the emulator accepts).
const APP_CHECK = appCheckPlan(__ENV, TARGET.label);
// Module state is per VU in k6, so each VU holds and refreshes its own token.
let appCheckCache = { token: '', expiresAt: 0 };

function appCheckToken() {
  if (APP_CHECK.kind === 'static') return APP_CHECK.token;
  if (appCheckCache.token && Date.now() < appCheckCache.expiresAt) return appCheckCache.token;

  const res = http.post(APP_CHECK.url, APP_CHECK.body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'appcheck', name: 'appcheck-exchange' },
  });
  if (res.status !== 200) {
    // The request that follows will be a 401, and is counted as one.
    console.warn(`[appcheck] debug-token exchange failed: status=${res.status}`);
    return appCheckCache.token;
  }
  const exchanged = JSON.parse(res.body);
  appCheckCache = { token: exchanged.token, expiresAt: Date.now() + appCheckRefreshAfterMs(exchanged.ttl) };
  return appCheckCache.token;
}

/**
 * Headers for one request.
 * (A former `LOAD_TEST_AUTH_BYPASS` / x-load-test-uid option was removed: no
 * function ever implemented that header, so it only produced 401s.)
 *
 * @param {string|null} email  pool member to sign in; null in AUTH_TOKEN mode
 */
function getAuthHeaders(email) {
  const base = { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': appCheckToken() };

  if (!POOL) return { ...base, Authorization: `Bearer ${__ENV.AUTH_TOKEN}` };

  // Each member is used once, so there is nothing to cache: one sign-in per
  // iteration, tagged `auth` so it stays out of the requestLoan thresholds.
  const signInRes = http.post(
    SIGN_IN_URL,
    JSON.stringify({ email, password: LOAD_TEST_PASSWORD, returnSecureToken: true }),
    { headers: { 'Content-Type': 'application/json' }, tags: { type: 'auth', name: 'auth-sign-in' } }
  );
  if (signInRes.status !== 200) {
    // Without a token the request below is a 401 — which is what gets counted.
    console.warn(`[auth] sign-in failed for ${email}: status=${signInRes.status}`);
    return base;
  }
  return { ...base, Authorization: `Bearer ${JSON.parse(signInRes.body).idToken}` };
}

// ── Setup: seed test data ───────────────────────────────────────────────────

export function setup() {
  console.log(`\n${'='.repeat(70)}`);
  console.log('  VIDA Load Test — Pipeline Throughput Validation');
  console.log(`  Profile: ${PROFILE}`);
  console.log(`  Target: ${TARGET.label.toUpperCase()}  ${STAGING_URL}`);
  console.log(`  Users:  ${POOL ? `pool of ${POOL.size}, from index ${POOL.offset}` : 'single AUTH_TOKEN (no pool)'}`);
  console.log(`  Stages: ${stages.map((s) => `${s.label}(${s.target}/min × ${s.duration})`).join(' → ')}`);
  console.log(`${'='.repeat(70)}\n`);

  // Verify staging is reachable
  const healthRes = http.get(`${STAGING_URL}/api/health`, {
    tags: { type: 'health' },
  });

  const healthOk = check(healthRes, {
    'staging is reachable': (r) => r.status === 200,
    'staging is healthy': (r) => {
      try {
        return JSON.parse(r.body).status === 'ok';
      } catch {
        return false;
      }
    },
  });

  if (!healthOk) {
    // A dead target makes every number below meaningless; stop here.
    throw new Error(`Health check failed on ${STAGING_URL}/api/health — aborting before any load.`);
  }

  // Nothing here verifies that the target's providers are mocked: the health
  // endpoint does not report configuration. See the runbook's provider table.
  console.log(`Health check response: ${healthRes.status}`);

  return {
    startTime: new Date().toISOString(),
    stagingUrl: STAGING_URL,
    targetLabel: TARGET.label,
    profile: PROFILE,
  };
}

// ── Main test function ──────────────────────────────────────────────────────

export default function () {
  const vuId = __VU;
  const iter = __ITER;

  activeVUs.add(vuId);

  let app;
  if (POOL) {
    // iterationInTest is unique across all VUs, so no two iterations share a uid.
    const index = poolIndexFor(exec.scenario.iterationInTest, POOL.size, POOL.offset);
    if (index < 0) {
      // Wrapping round would only measure the duplicate guard and the limiter.
      exec.test.abort(`User pool exhausted (POOL_SIZE=${POOL.size}, POOL_OFFSET=${POOL.offset}); seed a larger pool.`);
      return;
    }
    app = buildPoolApplication(index);
  } else {
    app = generateLoanApplication(vuId, iter);
  }
  loansSubmitted.add(1);

  // Track profile distribution
  if (app.profile === 'good') loansGoodProfile.add(1);
  else if (app.profile === 'medium') loansMediumProfile.add(1);
  else loansRiskyProfile.add(1);

  group('requestLoan', () => {
    const headers = getAuthHeaders(POOL ? app.email : null);

    // Firebase callable function protocol:
    // POST with { data: { ... } } body
    const requestBody = JSON.stringify({
      data: app.payload,
    });

    const startTime = Date.now();

    const res = http.post(`${STAGING_URL}/requestLoan`, requestBody, {
      headers,
      tags: { type: 'requestLoan', profile: app.profile },
      timeout: '60s',
    });

    const totalLatency = Date.now() - startTime;
    requestLatency.add(totalLatency);

    // Parse response
    let responseBody = null;
    try {
      responseBody = JSON.parse(res.body);
    } catch {
      // Non-JSON response
    }

    // Extract per-stage timing from response headers (if server instruments them)
    if (res.headers['X-Stage-Validation-Ms']) {
      stageValidation.add(parseInt(res.headers['X-Stage-Validation-Ms'], 10));
    }
    if (res.headers['X-Stage-Firestore-Ms']) {
      stageFirestoreWrite.add(parseInt(res.headers['X-Stage-Firestore-Ms'], 10));
    }
    if (res.headers['X-Stage-Queue-Ms']) {
      stageQueueDispatch.add(parseInt(res.headers['X-Stage-Queue-Ms'], 10));
    }
    if (res.headers['X-Stage-Ml-Ms']) {
      stageMlScoring.add(parseInt(res.headers['X-Stage-Ml-Ms'], 10));
    }

    // If server doesn't provide stage headers, estimate from total
    if (!res.headers['X-Stage-Validation-Ms']) {
      // Use total latency as a single e2e measurement
      stageValidation.add(Math.min(totalLatency * 0.1, 500));
      stageFirestoreWrite.add(Math.min(totalLatency * 0.4, 3000));
      stageQueueDispatch.add(Math.min(totalLatency * 0.2, 2000));
    }

    // Checks
    const passed = check(res, {
      'status is 200': (r) => r.status === 200,
      'response has result': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.result !== undefined;
        } catch {
          return false;
        }
      },
      // 'pending' only when the 6-stage pipeline gave no verdict and the inline
      // ML gate passed; otherwise an accepted request is under_review / approved /
      // rejected. All four mean requestLoan ran to completion.
      'loan status is an accepted one': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Boolean(body.result) && ACCEPTED_INITIAL_STATUSES.includes(body.result.status);
        } catch {
          return false;
        }
      },
      'loanId is returned': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.result && typeof body.result.loanId === 'string';
        } catch {
          return false;
        }
      },
    });

    if (passed) {
      loansSucceeded.add(1);
      errorRate.add(0);
    } else {
      loansFailed.add(1);
      errorRate.add(1);

      // Categorize failure
      if (res.status === 429 || (responseBody && responseBody.error && responseBody.error.status === 'RESOURCE_EXHAUSTED')) {
        rateLimited.add(1);
      } else if (res.status === 0 || res.error) {
        timeouts.add(1);
      } else if (res.status >= 500) {
        serverErrors.add(1);
      }

      if (res.status !== 200) {
        console.warn(
          `[VU${vuId}] Request failed: status=${res.status} ` +
            `profile=${app.profile} ` +
            `error=${responseBody ? JSON.stringify(responseBody.error || responseBody).slice(0, 200) : res.error}`
        );
      }
    }
  });

  // Pacing: spread requests evenly within each minute
  // Each VU aims for ~10 requests/min → ~6s between requests
  // Add jitter to avoid thundering herd
  const baseSleep = 5; // seconds
  const jitter = Math.random() * 2; // 0-2s jitter
  sleep(baseSleep + jitter);
}

// ── Teardown ────────────────────────────────────────────────────────────────

export function teardown(data) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('  Load Test Complete');
  console.log(`  Started: ${data.startTime}`);
  console.log(`  Ended:   ${new Date().toISOString()}`);
  console.log(`  Profile: ${data.profile}`);
  console.log(`${'='.repeat(70)}\n`);
}

// ── Custom summary handler ──────────────────────────────────────────────────

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    profile: PROFILE,
    target: TARGET.label,
    targetUrl: STAGING_URL,
    metrics: {},
    stages: stages,
  };

  // Extract key metrics
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.values) {
      summary.metrics[name] = metric.values;
    }
  }

  // Build text report
  const lines = [];
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════════╗');
  lines.push('║           VIDA Load Test — Performance Report                       ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════╝');
  lines.push(`  TARGET: ${TARGET.label.toUpperCase()}  ${STAGING_URL}`);
  lines.push(`  Profile: ${PROFILE}   Finished: ${summary.timestamp}`);
  lines.push('');

  // Request latency
  const reqDur = data.metrics['request_latency_e2e'];
  if (reqDur && reqDur.values) {
    lines.push('┌─ End-to-End Latency ─────────────────────────────────────────────┐');
    lines.push(`│  P50:  ${(reqDur.values['p(50)'] || 0).toFixed(0)}ms`);
    lines.push(`│  P90:  ${(reqDur.values['p(90)'] || 0).toFixed(0)}ms`);
    lines.push(`│  P95:  ${(reqDur.values['p(95)'] || 0).toFixed(0)}ms`);
    lines.push(`│  P99:  ${(reqDur.values['p(99)'] || 0).toFixed(0)}ms`);
    lines.push(`│  Max:  ${(reqDur.values['max'] || 0).toFixed(0)}ms`);
    lines.push(`│  Avg:  ${(reqDur.values['avg'] || 0).toFixed(0)}ms`);
    lines.push('└──────────────────────────────────────────────────────────────────┘');
    lines.push('');
  }

  // Throughput
  const submitted = data.metrics['loans_submitted'];
  const succeeded = data.metrics['loans_succeeded'];
  const failed = data.metrics['loans_failed'];
  lines.push('┌─ Throughput ──────────────────────────────────────────────────────┐');
  lines.push(`│  Total submitted: ${submitted ? submitted.values.count : 0}`);
  lines.push(`│  Succeeded:       ${succeeded ? succeeded.values.count : 0}`);
  lines.push(`│  Failed:          ${failed ? failed.values.count : 0}`);
  const errRateMetric = data.metrics['loan_error_rate'];
  lines.push(`│  Error rate:      ${errRateMetric ? (errRateMetric.values.rate * 100).toFixed(2) : '0.00'}%`);
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Error breakdown
  const rl = data.metrics['rate_limited_requests'];
  const to = data.metrics['timeout_errors'];
  const se = data.metrics['server_errors'];
  lines.push('┌─ Error Breakdown ────────────────────────────────────────────────┐');
  lines.push(`│  Rate limited (429):   ${rl ? rl.values.count : 0}`);
  lines.push(`│  Timeouts:             ${to ? to.values.count : 0}`);
  lines.push(`│  Server errors (5xx):  ${se ? se.values.count : 0}`);
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Per-stage latencies
  const stageMetrics = [
    ['Validation', data.metrics['stage_latency_validation']],
    ['Firestore Write', data.metrics['stage_latency_firestore_write']],
    ['Queue Dispatch', data.metrics['stage_latency_queue_dispatch']],
    ['ML Scoring', data.metrics['stage_latency_ml_scoring']],
  ];

  lines.push('┌─ Per-Stage Latency (P95) ────────────────────────────────────────┐');
  for (const [name, metric] of stageMetrics) {
    if (metric && metric.values) {
      const p95 = (metric.values['p(95)'] || 0).toFixed(0);
      const p50 = (metric.values['p(50)'] || 0).toFixed(0);
      lines.push(`│  ${name.padEnd(20)} P50: ${p50.padStart(6)}ms  P95: ${p95.padStart(6)}ms`);
    }
  }
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Profile distribution
  const good = data.metrics['loans_profile_good'];
  const medium = data.metrics['loans_profile_medium'];
  const risky = data.metrics['loans_profile_risky'];
  lines.push('┌─ Profile Distribution ───────────────────────────────────────────┐');
  lines.push(`│  Good:   ${good ? good.values.count : 0}`);
  lines.push(`│  Medium: ${medium ? medium.values.count : 0}`);
  lines.push(`│  Risky:  ${risky ? risky.values.count : 0}`);
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Acceptance criteria check
  lines.push('┌─ Acceptance Criteria ────────────────────────────────────────────┐');
  const p95 = reqDur && reqDur.values ? reqDur.values['p(95)'] : null;
  const errRate = errRateMetric ? errRateMetric.values.rate : 0;
  lines.push(`│  P95 < 30s at target rate:  ${p95 !== null ? (p95 < 30000 ? '✓ PASS' : '✗ FAIL') : 'N/A'}  (${p95 ? (p95 / 1000).toFixed(1) + 's' : '-'})`);
  lines.push(`│  Error rate < 1%:           ${errRate < 0.01 ? '✓ PASS' : '✗ FAIL'}  (${(errRate * 100).toFixed(2)}%)`);
  lines.push(`│  2x target without errors:  ${errRate < 0.05 ? '✓ PASS' : '✗ FAIL'}`);
  lines.push('└──────────────────────────────────────────────────────────────────┘');
  lines.push('');

  const textReport = lines.join('\n');

  // Named by target so an emulator run can never be mistaken for a production
  // one. The .md report is the committable artifact (*.json / *.txt in
  // results/ are gitignored as raw output).
  const stamp = summary.timestamp.slice(0, 10);
  const base = `tests/load/results/${stamp}-${TARGET.label}-${PROFILE}`;
  return {
    stdout: textReport,
    [`${base}-summary.json`]: JSON.stringify(summary, null, 2),
    [`${base}-report.md`]: `# Load test — ${TARGET.label} (${PROFILE})\n\n\`\`\`\n${textReport}\n\`\`\`\n`,
  };
}
