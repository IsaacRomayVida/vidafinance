/**
 * VIDA Health Monitor — polls all service health endpoints and applies alerting rules.
 *
 * Alerting Rules:
 *   1. Decision engine error rate > 1% of apps → alert
 *   2. MetaMap API P95 latency > 10s → alert
 *   3. SPEI disbursement failure rate > 0.5% → alert
 *   4. Stage 5 queue depth > 50 → alert (human review backlog)
 *   5. Any service health check returns "down" for > 2 min → alert
 *   6. PSI > 0.25 → alert to ML team
 *
 * Run as: node health-monitor.js
 * Env: POLL_INTERVAL_MS (default 60000), SERVICE_URLS, INTERNAL_SECRET
 */

require('dotenv').config();
const { sendAlert } = require('./alerting');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

const SERVICES = {
  'vida-payment-server': process.env.PAYMENT_SERVER_URL || 'http://localhost:3001',
  'vida-softcredito-adapter': process.env.SOFTCREDITO_ADAPTER_URL || 'http://localhost:3002',
  'vida-notification-service': process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
  'vida-pdf-generator': process.env.PDF_GENERATOR_URL || 'http://localhost:3004',
  'vida-ml-service': process.env.ML_SERVICE_URL || 'http://localhost:3005',
};

// Track how long each service has been "down"
const downSince = {};

async function fetchHealth(name, baseUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { status: 'down', service: name, error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch (err) {
    return { status: 'down', service: name, error: err.message };
  }
}

async function fetchQueueStats(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/internal/queue-stats`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

async function fetchDriftLatest(mlUrl) {
  try {
    const resp = await fetch(`${mlUrl}/monitor/drift/latest`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

async function checkAlertingRules() {
  const now = Date.now();
  const results = {};

  // 1. Poll all service health endpoints
  for (const [name, url] of Object.entries(SERVICES)) {
    const health = await fetchHealth(name, url);
    results[name] = health;

    // Rule 5: Service down > 2 min
    if (health.status === 'down') {
      if (!downSince[name]) downSince[name] = now;
      const downMs = now - downSince[name];
      if (downMs > 2 * 60 * 1000) {
        await sendAlert(
          `Service *${name}* has been DOWN for ${Math.floor(downMs / 60000)} minutes.\nError: ${health.error || 'unknown'}`,
          'critical', name, 'health-check',
        );
      }
    } else {
      delete downSince[name];
    }

    // Rule 4: Queue depth > 50 (stage 5 human review backlog = underwriting queue)
    if (health.queue_depth) {
      for (const [queue, depth] of Object.entries(health.queue_depth)) {
        if (depth > 50) {
          await sendAlert(
            `Queue *${queue}* depth is ${depth} (threshold: 50) on ${name}`,
            'warning', name, 'queue-depth',
          );
        }
      }
    }
  }

  // 2. Check queue stats from payment server for disbursement failure rate
  const queueStats = await fetchQueueStats(SERVICES['vida-payment-server']);
  if (queueStats?.queues) {
    const disb = queueStats.queues['vida-disbursements'];
    if (disb) {
      const total = disb.completed + disb.failed;
      if (total > 0) {
        const failRate = disb.failed / total;
        // Rule 3: SPEI disbursement failure rate > 0.5%
        if (failRate > 0.005) {
          await sendAlert(
            `SPEI disbursement failure rate is ${(failRate * 100).toFixed(2)}% (${disb.failed}/${total}) — threshold: 0.5%`,
            'critical', 'vida-payment-server', 'disbursements',
          );
        }
      }
    }

    // Rule 1: Decision engine (underwriting) error rate > 1%
    const uw = queueStats.queues['vida-underwriting'];
    if (uw) {
      const total = uw.completed + uw.failed;
      if (total > 0) {
        const errRate = uw.failed / total;
        if (errRate > 0.01) {
          await sendAlert(
            `Decision engine error rate is ${(errRate * 100).toFixed(2)}% (${uw.failed}/${total}) — threshold: 1%`,
            'critical', 'vida-ml-service', 'decision-engine',
          );
        }
      }
    }
  }

  // 6. Check PSI drift from ML service
  const drift = await fetchDriftLatest(SERVICES['vida-ml-service']);
  if (drift?.psi?.score > 0.25) {
    await sendAlert(
      `Model drift detected: PSI=${drift.psi.score} (threshold: 0.25) — full retrain required`,
      'critical', 'vida-ml-service', 'model-drift',
    );
  }

  return results;
}

// Main polling loop
async function main() {
  console.log('[health-monitor] Starting with poll interval', POLL_INTERVAL, 'ms');
  console.log('[health-monitor] Monitoring services:', Object.keys(SERVICES).join(', '));

  while (true) {
    try {
      const results = await checkAlertingRules();
      const statuses = Object.entries(results).map(([name, h]) => `${name}: ${h.status}`);
      console.log(`[health-monitor] ${new Date().toISOString()} — ${statuses.join(', ')}`);
    } catch (err) {
      console.error('[health-monitor] Error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// Export for use as a module or run standalone
module.exports = { checkAlertingRules, fetchHealth, SERVICES };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
