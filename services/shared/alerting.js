/**
 * Shared alerting module for VIDA Finance.
 *
 * Sends alerts to Slack and PagerDuty via webhooks.
 * Used by all Node.js services for production alerting.
 *
 * Environment variables:
 *   SLACK_WEBHOOK_URL      — Slack incoming webhook URL
 *   PAGERDUTY_ROUTING_KEY  — PagerDuty Events API v2 routing key
 */

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY || '';

/**
 * Send alert to Slack.
 * @param {string} message - Alert text
 * @param {'warning'|'critical'} level
 */
async function sendSlackAlert(message, level = 'warning') {
  if (!SLACK_WEBHOOK_URL) return;
  const emoji = level === 'critical' ? ':rotating_light:' : ':warning:';
  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${emoji} *VIDA Alert* (${level.toUpperCase()})\n${message}` }),
    });
    if (!resp.ok) console.warn('[alerting] Slack webhook returned', resp.status);
  } catch (err) {
    console.warn('[alerting] Slack alert failed:', err.message);
  }
}

/**
 * Send alert to PagerDuty.
 * @param {string} summary
 * @param {'warning'|'critical'} severity
 * @param {string} source - Service name
 * @param {string} component
 */
async function sendPagerDutyAlert(summary, severity = 'warning', source = 'vida', component = 'unknown') {
  if (!PAGERDUTY_ROUTING_KEY) return;
  try {
    const resp = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key: PAGERDUTY_ROUTING_KEY,
        event_action: 'trigger',
        payload: { summary, severity, source, component, group: 'vida', class: 'monitoring' },
      }),
    });
    if (!resp.ok && resp.status !== 202) console.warn('[alerting] PagerDuty returned', resp.status);
  } catch (err) {
    console.warn('[alerting] PagerDuty alert failed:', err.message);
  }
}

/**
 * Send alert to all configured channels.
 * @param {string} message
 * @param {'warning'|'critical'} level
 * @param {string} source
 * @param {string} component
 */
async function sendAlert(message, level = 'warning', source = 'vida', component = 'unknown') {
  await Promise.allSettled([
    sendSlackAlert(message, level),
    sendPagerDutyAlert(message, level === 'critical' ? 'critical' : 'warning', source, component),
  ]);
}

module.exports = { sendAlert, sendSlackAlert, sendPagerDutyAlert };
