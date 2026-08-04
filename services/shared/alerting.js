/**
 * Shared alerting module for VIDA Finance.
 *
 * Sends structured alerts to Slack (#vida-alerts) and PagerDuty.
 * Used by all Node.js services for production alerting.
 *
 * Alert levels:
 *   - warning  → Slack only (5xx, queue depth, rate limits, etc.)
 *   - critical → Slack + PagerDuty page (health down, disbursement failed, etc.)
 *
 * Rate limiting: max 1 alert per key per 5 minutes (deduplication),
 * enforced per process — each running instance of a service keeps its own
 * dedup table, so a service with N instances can still emit up to N alerts
 * for the same key inside one window. Acceptable: it bounds spam from a
 * single instance, which is what actually loops (retries, poll ticks); it
 * does not require new shared infrastructure (e.g. Redis) to fix.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL      — Slack incoming webhook URL (#vida-alerts)
 *   PAGERDUTY_ROUTING_KEY  — PagerDuty Events API v2 routing key
 *
 * Read at call time, not captured into a module-level const at require
 * time: several call sites `require('../shared/alerting')` before their own
 * `dotenv.config()` runs, which would otherwise freeze these to '' forever
 * for that process regardless of what .env later provides.
 */

function _slackWebhookUrl() {
  return process.env.SLACK_WEBHOOK_URL || '';
}

function _pagerDutyRoutingKey() {
  return process.env.PAGERDUTY_ROUTING_KEY || '';
}

// ── Unconfigured-channel warning (once per process, not once per alert) ──
const _unconfiguredWarned = new Set();

function _warnUnconfigured(channel, envVar) {
  if (_unconfiguredWarned.has(channel)) return;
  _unconfiguredWarned.add(channel);
  console.error(
    `[alerting] ${envVar} is not set — every ${channel} alert this process sends from now on ` +
    `will be silently dropped. This is the only time this will be logged for ${channel}.`,
  );
}

// ── Rate limiting ─────────────────────────────────────────────────────
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const _recentAlerts = new Map(); // key → timestamp

function _isDuplicate(alertKey) {
  const now = Date.now();
  const last = _recentAlerts.get(alertKey);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  _recentAlerts.set(alertKey, now);
  // Prune old entries periodically
  if (_recentAlerts.size > 500) {
    for (const [k, ts] of _recentAlerts) {
      if (now - ts > DEDUP_WINDOW_MS) _recentAlerts.delete(k);
    }
  }
  return false;
}

// ── Runbook links ─────────────────────────────────────────────────────
const RUNBOOK_BASE = 'https://linear.app/vidateam/document';
const RUNBOOKS = {
  'health_down':         `${RUNBOOK_BASE}/runbook-service-health-down-d1a2b3`,
  'disbursement_failed': `${RUNBOOK_BASE}/runbook-disbursement-failed-e4f5a6`,
  'redis_lost':          `${RUNBOOK_BASE}/runbook-redis-connection-lost-b7c8d9`,
  'webhook_stuck':       `${RUNBOOK_BASE}/runbook-webhook-stuck-f0a1b2`,
  'firestore_failure':   `${RUNBOOK_BASE}/runbook-firestore-write-failure-c3d4e5`,
  'fraud_high':          `${RUNBOOK_BASE}/runbook-fraud-score-critical-a6b7c8`,
};

// ── Slack ──────────────────────────────────────────────────────────────
async function sendSlackAlert(message, level = 'warning', { service, alertType, runbook } = {}) {
  const webhookUrl = _slackWebhookUrl();
  if (!webhookUrl) {
    _warnUnconfigured('Slack', 'SLACK_WEBHOOK_URL');
    return;
  }
  const emoji = level === 'critical' ? ':rotating_light:' : ':warning:';
  const svcLabel = service ? ` \`${service}\`` : '';
  const typeLabel = alertType ? ` — ${alertType}` : '';
  const runbookUrl = runbook ? RUNBOOKS[runbook] : null;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *VIDA Alert* (${level.toUpperCase()})${svcLabel}${typeLabel}\n\n${message}`,
      },
    },
  ];

  if (runbookUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:book: <${runbookUrl}|Runbook>` }],
    });
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks, text: `${emoji} VIDA Alert (${level.toUpperCase()})${svcLabel}: ${message}` }),
    });
    if (!resp.ok) console.warn('[alerting] Slack webhook returned', resp.status);
  } catch (err) {
    console.warn('[alerting] Slack alert failed:', err.message);
  }
}

// ── PagerDuty ─────────────────────────────────────────────────────────
async function sendPagerDutyAlert(summary, severity = 'warning', source = 'vida', component = 'unknown', { runbook } = {}) {
  const routingKey = _pagerDutyRoutingKey();
  if (!routingKey) {
    _warnUnconfigured('PagerDuty', 'PAGERDUTY_ROUTING_KEY');
    return;
  }
  const payload = {
    routing_key: routingKey,
    event_action: 'trigger',
    payload: { summary, severity, source, component, group: 'vida', class: 'monitoring' },
  };
  const runbookUrl = runbook ? RUNBOOKS[runbook] : null;
  if (runbookUrl) {
    payload.links = [{ href: runbookUrl, text: 'Runbook' }];
  }
  try {
    const resp = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok && resp.status !== 202) console.warn('[alerting] PagerDuty returned', resp.status);
  } catch (err) {
    console.warn('[alerting] PagerDuty alert failed:', err.message);
  }
}

// ── Unified alert dispatcher ──────────────────────────────────────────
/**
 * Send a structured alert.
 *
 * @param {object} opts
 * @param {string} opts.message    - Human-readable alert text
 * @param {'warning'|'critical'} opts.level - warning=Slack only, critical=Slack+PagerDuty
 * @param {string} opts.service    - Service name (e.g. 'vida-payment-server')
 * @param {string} opts.component  - Component within service (e.g. 'disbursement-worker')
 * @param {string} [opts.alertType] - Short label (e.g. '5xx', 'queue_depth')
 * @param {string} [opts.runbook]  - Runbook key from RUNBOOKS map
 * @param {string} [opts.dedupKey] - Custom dedup key; defaults to `${service}:${alertType}`
 */
async function alert({ message, level = 'warning', service = 'vida', component = 'unknown', alertType = '', runbook, dedupKey }) {
  const key = dedupKey || `${service}:${alertType || component}`;
  if (_isDuplicate(key)) return;

  const slackOpts = { service, alertType, runbook };
  const pdOpts = { runbook };

  if (level === 'critical') {
    // Critical: Slack + PagerDuty
    await Promise.allSettled([
      sendSlackAlert(message, level, slackOpts),
      sendPagerDutyAlert(message, 'critical', service, component, pdOpts),
    ]);
  } else {
    // Warning: Slack only
    await sendSlackAlert(message, level, slackOpts);
  }
}

// ── Convenience helpers ───────────────────────────────────────────────

/** 5xx error on a public endpoint */
function alert5xx(service, statusCode, path) {
  return alert({
    message: `HTTP ${statusCode} on \`${path}\``,
    level: 'warning',
    service,
    component: 'http',
    alertType: '5xx',
    dedupKey: `${service}:5xx:${path}`,
  });
}

/** Queue depth exceeded threshold */
function alertQueueDepth(service, queueName, depth, threshold = 100) {
  return alert({
    message: `Queue \`${queueName}\` depth is *${depth}* (threshold: ${threshold})`,
    level: 'warning',
    service,
    component: 'queue',
    alertType: 'queue_depth',
    dedupKey: `${service}:queue_depth:${queueName}`,
  });
}

/** Webhook retries exceeded */
function alertWebhookRetries(service, webhookType, retries) {
  return alert({
    message: `Webhook \`${webhookType}\` has retried *${retries}* times`,
    level: 'warning',
    service,
    component: 'webhook',
    alertType: 'webhook_retries',
    runbook: 'webhook_stuck',
    dedupKey: `${service}:webhook_retries:${webhookType}`,
  });
}

/** Rate limit hit on external API */
function alertRateLimit(service, apiName) {
  return alert({
    message: `Rate limit hit on \`${apiName}\``,
    level: 'warning',
    service,
    component: 'external-api',
    alertType: 'rate_limit',
    dedupKey: `${service}:rate_limit:${apiName}`,
  });
}

/** ML model fallback from champion to challenger */
function alertModelFallback(service, reason) {
  return alert({
    message: `ML model fallback from champion → challenger: ${reason}`,
    level: 'warning',
    service,
    component: 'ml-model',
    alertType: 'model_fallback',
  });
}

/** Health check down for > 60s (PagerDuty incident) */
function alertHealthDown(service, durationMs, error) {
  return alert({
    message: `Service has been *DOWN* for ${Math.floor(durationMs / 1000)}s.\nError: ${error || 'unknown'}`,
    level: 'critical',
    service,
    component: 'health-check',
    alertType: 'health_down',
    runbook: 'health_down',
  });
}

/** Disbursement failed (PagerDuty incident) */
function alertDisbursementFailed(service, loanId, error) {
  return alert({
    message: `Disbursement failed for loan \`${loanId}\`.\nError: ${error}`,
    level: 'critical',
    service,
    component: 'disbursement',
    alertType: 'disbursement_failed',
    runbook: 'disbursement_failed',
    dedupKey: `${service}:disbursement_failed:${loanId}`,
  });
}

/** Fraud score above threshold (PagerDuty incident) */
function alertFraudScore(service, score, employeeId) {
  return alert({
    message: `Fraud score *${score}* (> 85) for employee \`${employeeId}\` at Stage 0`,
    level: 'critical',
    service,
    component: 'fraud-detection',
    alertType: 'fraud_high',
    runbook: 'fraud_high',
    dedupKey: `${service}:fraud_high:${employeeId}`,
  });
}

/** Redis connection lost (PagerDuty incident) */
function alertRedisLost(service) {
  return alert({
    message: 'Redis connection lost',
    level: 'critical',
    service,
    component: 'redis',
    alertType: 'redis_lost',
    runbook: 'redis_lost',
  });
}

/** Firestore write failure rate exceeded (PagerDuty incident) */
function alertFirestoreFailure(service, failureRate) {
  return alert({
    message: `Firestore write failure rate is *${(failureRate * 100).toFixed(1)}%* (threshold: 5%)`,
    level: 'critical',
    service,
    component: 'firestore',
    alertType: 'firestore_failure',
    runbook: 'firestore_failure',
  });
}

module.exports = {
  // Core
  alert,
  sendSlackAlert,
  sendPagerDutyAlert,
  // Legacy compat (used by health-monitor.js)
  sendAlert: async (message, level, source, component) =>
    alert({ message, level, service: source, component }),
  // Convenience helpers
  alert5xx,
  alertQueueDepth,
  alertWebhookRetries,
  alertRateLimit,
  alertModelFallback,
  alertHealthDown,
  alertDisbursementFailed,
  alertFraudScore,
  alertRedisLost,
  alertFirestoreFailure,
  // Constants (for testing)
  RUNBOOKS,
  DEDUP_WINDOW_MS,
  // Test-only: clears dedup + once-per-process warning state
  _resetForTests: () => {
    _recentAlerts.clear();
    _unconfiguredWarned.clear();
  },
};
