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
const createLogger = require('./logger');

const log = createLogger('vida-health-monitor');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

// Every service the platform runs, with the env var carrying its URL in
// production and the port it actually listens on in dev.
//
// The localhost value is a DEV default. In production a service still sitting on
// it has not been configured, which is a deployment gap and NOT an outage — see
// `unconfiguredInProd` below for why the two must alert differently.
const SERVICE_DEFS = [
  { name: 'vida-payment-server', env: 'PAYMENT_SERVER_URL', dev: 'http://localhost:3001' },
  { name: 'vida-softcredito-adapter', env: 'SOFTCREDITO_ADAPTER_URL', dev: 'http://localhost:3002' },
  { name: 'vida-notification-service', env: 'NOTIFICATION_SERVICE_URL', dev: 'http://localhost:3003' },
  { name: 'vida-pdf-generator', env: 'PDF_GENERATOR_URL', dev: 'http://localhost:3004' },
  { name: 'vida-ml-service', env: 'ML_SERVICE_URL', dev: 'http://localhost:3005' },

  // Added 2026-08-03. Both were absent from launch monitoring while being the
  // two services the product cannot transact without: underwriting makes the
  // credit decision, registry holds the ledger. Every one of the five above
  // could report green while no loan on the platform can be approved — exactly
  // the blind spot the v1.7 launch checklist certified as complete.
  //
  // NOTE: underwriting genuinely listens on 3003 (Dockerfile EXPOSE 3003,
  // index.js:223), the same port notification-service declares. They do not
  // collide in production — Railway gives each service its own container — but
  // they DO collide if both are run locally. Left accurate rather than assigned
  // a tidy free port: a monitor aimed at a port the service does not listen on
  // is worse than one that reveals the clash.
  { name: 'vida-underwriting-service', env: 'UNDERWRITING_SERVICE_URL', dev: 'http://localhost:3003' },
  { name: 'vida-registry-service', env: 'REGISTRY_SERVICE_URL', dev: 'http://localhost:3006' },
];

const IS_PROD = process.env.NODE_ENV === 'production';

const SERVICES = Object.fromEntries(
  SERVICE_DEFS.map(({ name, env, dev }) => [name, process.env[env] || dev]),
);

// Services that fell back to a dev default while running in production. Their
// health is unknowable rather than bad, so Rule 5 must not page on them: a URL
// we never configured cannot tell us the service is down, and paging the
// on-call for an unset env var is how alerting gets muted wholesale. This
// mirrors the read/assumed provenance split the decision engine already uses —
// absence of a measurement is not a measurement of absence.
const unconfiguredInProd = new Set(
  IS_PROD ? SERVICE_DEFS.filter(({ env }) => !process.env[env]).map(({ name }) => name) : [],
);

// Track how long each service has been "down"
const downSince = {};

// Config gaps are a standing condition, not an event: alert once per process so
// the warning is seen without repeating every poll interval forever.
const unconfiguredAlerted = new Set();

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
    // A service with no URL configured in production is a deployment gap. Report
    // it as its own state and skip the poll entirely — probing localhost from a
    // production container tells us nothing about the real service, and the
    // guaranteed connection refusal would otherwise look identical to a genuine
    // outage and page every two minutes forever.
    if (unconfiguredInProd.has(name)) {
      results[name] = {
        status: 'unconfigured',
        service: name,
        error: `No URL configured in production — set the env var for ${name}`,
      };
      if (!unconfiguredAlerted.has(name)) {
        unconfiguredAlerted.add(name);
        await sendAlert(
          `Service *${name}* has no URL configured in production, so it is NOT being health-checked. This is a deployment gap, not an outage — set its URL env var.`,
          'warning', name, 'health-check-unconfigured',
        );
      }
      continue;
    }

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
      const statuses = Object.fromEntries(Object.entries(results).map(([name, h]) => [name, h.status]));
      log.info({ statuses }, 'Health poll complete');
    } catch (err) {
      console.error('[health-monitor] Error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// Export for use as a module or run standalone
module.exports = { checkAlertingRules, fetchHealth, SERVICES, SERVICE_DEFS, unconfiguredInProd };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
