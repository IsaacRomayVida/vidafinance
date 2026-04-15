/**
 * Shared alerting module for VIDA Finance.
 *
 * Sends alerts to Slack and PagerDuty via webhooks with proper
 * SEV-1/SEV-2 incident classification, deduplication, and enrichment.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL      — Slack incoming webhook URL
 *   PAGERDUTY_ROUTING_KEY  — PagerDuty Events API v2 routing key
 *   NODE_ENV               — Used to tag environment in alerts
 */

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY || '';
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Incident severity definitions aligned with VIDA runbooks.
 *
 * SEV-1 (critical): All services down, Redis OOM, disbursement stalled
 *   → 15 min response, pages on-call immediately, escalates to eng lead + CTO
 *
 * SEV-2 (error): Single service >5min, error rate >5%, MetaMap outage
 *   → 30 min response, pages on-call
 *
 * SEV-3 (warning): Non-critical degradation
 *   → 4 hour response, Slack only
 *
 * SEV-4 (info): Minor issues, no user impact
 *   → Next business day, Slack only
 */
const SEVERITY = {
  SEV1: 'critical',
  SEV2: 'error',
  SEV3: 'warning',
  SEV4: 'info',
};

const SEVERITY_LABELS = {
  critical: 'SEV-1',
  error: 'SEV-2',
  warning: 'SEV-3',
  info: 'SEV-4',
};

const SEVERITY_EMOJI = {
  critical: ':rotating_light:',
  error: ':fire:',
  warning: ':warning:',
  info: ':information_source:',
};

/**
 * SEV-1 incident conditions.
 * Used by the health monitor to auto-classify severity.
 */
const SEV1_CONDITIONS = [
  'all_services_down',
  'redis_oom',
  'redis_connection_refused',
  'disbursement_stalled',
  'firestore_outage',
  'multiple_services_down',
];

/**
 * SEV-2 incident conditions.
 */
const SEV2_CONDITIONS = [
  'single_service_down_extended',
  'error_rate_high',
  'metamap_outage',
  'payment_queue_stalled',
  'disbursement_failure_rate_high',
];

/**
 * Generate a deduplication key for PagerDuty.
 * Same dedup_key prevents duplicate incidents for the same root cause.
 * @param {string} source - Service name
 * @param {string} component - Component within service
 * @param {string} [conditionId] - Specific condition identifier
 * @returns {string}
 */
function generateDedupKey(source, component, conditionId) {
  const parts = ['vida', source, component];
  if (conditionId) parts.push(conditionId);
  return parts.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Send alert to Slack.
 * @param {string} message - Alert text
 * @param {string} severity - PagerDuty severity string
 * @param {object} [opts] - Additional options
 * @param {string} [opts.sevLabel] - Override severity label
 */
async function sendSlackAlert(message, severity = 'warning', opts = {}) {
  if (!SLACK_WEBHOOK_URL) return;
  const emoji = SEVERITY_EMOJI[severity] || ':warning:';
  const label = opts.sevLabel || SEVERITY_LABELS[severity] || severity.toUpperCase();
  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${emoji} *VIDA Alert* (${label})\n${message}`,
      }),
    });
    if (!resp.ok) console.warn('[alerting] Slack webhook returned', resp.status);
  } catch (err) {
    console.warn('[alerting] Slack alert failed:', err.message);
  }
}

/**
 * Send alert to PagerDuty Events API v2.
 *
 * @param {object} params
 * @param {string} params.summary - Human-readable incident summary
 * @param {string} params.severity - One of: critical, error, warning, info
 * @param {string} params.source - Service name (e.g. 'vida-payment-server')
 * @param {string} params.component - Component (e.g. 'disbursements')
 * @param {string} [params.dedupKey] - Deduplication key
 * @param {string} [params.group] - Logical grouping
 * @param {string} [params.classType] - Alert class
 * @param {object} [params.customDetails] - Arbitrary key-value details
 * @param {string[]} [params.links] - Related links (runbook URLs, dashboards)
 * @returns {Promise<{status: string, dedupKey: string}|null>}
 */
async function sendPagerDutyAlert({
  summary,
  severity = 'warning',
  source = 'vida',
  component = 'unknown',
  dedupKey,
  group = 'vida',
  classType = 'monitoring',
  customDetails = {},
  links = [],
} = {}) {
  if (!PAGERDUTY_ROUTING_KEY) return null;

  const resolvedDedupKey = dedupKey || generateDedupKey(source, component);

  const payload = {
    routing_key: PAGERDUTY_ROUTING_KEY,
    event_action: 'trigger',
    dedup_key: resolvedDedupKey,
    payload: {
      summary: `[${SEVERITY_LABELS[severity] || severity}] ${summary}`,
      severity,
      source,
      component,
      group,
      class: classType,
      timestamp: new Date().toISOString(),
      custom_details: {
        environment: NODE_ENV,
        severity_label: SEVERITY_LABELS[severity] || severity,
        ...customDetails,
      },
    },
    links: links.map((l) =>
      typeof l === 'string' ? { href: l, text: 'Runbook' } : l,
    ),
  };

  try {
    const resp = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = resp.ok || resp.status === 202 ? await resp.json().catch(() => null) : null;
    if (!resp.ok && resp.status !== 202) {
      console.warn('[alerting] PagerDuty returned', resp.status);
    }
    return { status: resp.status === 202 ? 'success' : `http_${resp.status}`, dedupKey: resolvedDedupKey };
  } catch (err) {
    console.warn('[alerting] PagerDuty alert failed:', err.message);
    return null;
  }
}

/**
 * Resolve a PagerDuty incident by dedup key.
 * @param {string} dedupKey
 * @returns {Promise<boolean>}
 */
async function resolvePagerDutyIncident(dedupKey) {
  if (!PAGERDUTY_ROUTING_KEY || !dedupKey) return false;
  try {
    const resp = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key: PAGERDUTY_ROUTING_KEY,
        event_action: 'resolve',
        dedup_key: dedupKey,
      }),
    });
    return resp.ok || resp.status === 202;
  } catch (err) {
    console.warn('[alerting] PagerDuty resolve failed:', err.message);
    return false;
  }
}

/**
 * Classify severity based on incident condition.
 * @param {string} condition - One of the defined condition IDs
 * @returns {string} PagerDuty severity string
 */
function classifySeverity(condition) {
  if (SEV1_CONDITIONS.includes(condition)) return SEVERITY.SEV1;
  if (SEV2_CONDITIONS.includes(condition)) return SEVERITY.SEV2;
  return SEVERITY.SEV3;
}

/**
 * Send alert to all configured channels with proper severity classification.
 *
 * @param {string} message - Human-readable alert message
 * @param {string} severity - PagerDuty severity: critical, error, warning, info
 * @param {string} source - Service name
 * @param {string} component - Component within service
 * @param {object} [opts] - Additional options
 * @param {string} [opts.condition] - Condition ID for auto-classification
 * @param {string} [opts.dedupKey] - Override dedup key
 * @param {object} [opts.customDetails] - Extra details for PagerDuty
 * @param {string[]} [opts.links] - Runbook/dashboard links
 */
async function sendAlert(message, severity = 'warning', source = 'vida', component = 'unknown', opts = {}) {
  // Auto-classify if a condition is provided
  const resolvedSeverity = opts.condition
    ? classifySeverity(opts.condition)
    : severity;

  // Only page for SEV-1 and SEV-2 (critical/error)
  const shouldPage = resolvedSeverity === 'critical' || resolvedSeverity === 'error';

  const promises = [sendSlackAlert(message, resolvedSeverity)];

  if (shouldPage) {
    promises.push(
      sendPagerDutyAlert({
        summary: message,
        severity: resolvedSeverity,
        source,
        component,
        dedupKey: opts.dedupKey || generateDedupKey(source, component, opts.condition),
        customDetails: opts.customDetails,
        links: opts.links,
      }),
    );
  }

  await Promise.allSettled(promises);
}

module.exports = {
  sendAlert,
  sendSlackAlert,
  sendPagerDutyAlert,
  resolvePagerDutyIncident,
  classifySeverity,
  generateDedupKey,
  SEVERITY,
  SEVERITY_LABELS,
  SEV1_CONDITIONS,
  SEV2_CONDITIONS,
};
