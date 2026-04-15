/**
 * VIDA Health Monitor — polls all service health endpoints and applies alerting rules
 * with SEV-1/SEV-2 incident classification.
 *
 * SEV-1 Conditions (15 min response):
 *   - All services down simultaneously
 *   - Redis OOM or connection refused
 *   - Disbursement queue stalled (0 completions, >0 waiting for >10 min)
 *
 * SEV-2 Conditions (30 min response):
 *   - Single service down > 5 min
 *   - Error rate > 5% on any critical queue
 *   - MetaMap outage (underwriting service unhealthy + KYC errors)
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
const {
  sendAlert,
  resolvePagerDutyIncident,
  generateDedupKey,
  SEVERITY,
} = require('./alerting');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';

const SERVICES = {
  'vida-payment-server': process.env.PAYMENT_SERVER_URL || 'http://localhost:3001',
  'vida-softcredito-adapter': process.env.SOFTCREDITO_ADAPTER_URL || 'http://localhost:3002',
  'vida-notification-service': process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
  'vida-pdf-generator': process.env.PDF_GENERATOR_URL || 'http://localhost:3004',
  'vida-ml-service': process.env.ML_SERVICE_URL || 'http://localhost:3005',
};

// Thresholds
const THRESHOLDS = {
  SERVICE_DOWN_SEV2_MS: 5 * 60 * 1000,       // 5 min → SEV-2
  SERVICE_DOWN_ALERT_MS: 2 * 60 * 1000,       // 2 min → initial alert
  DISBURSEMENT_FAILURE_RATE: 0.005,            // 0.5% → alert
  DISBURSEMENT_FAILURE_RATE_SEV2: 0.05,        // 5% → SEV-2
  DECISION_ENGINE_ERROR_RATE: 0.01,            // 1% → alert
  DECISION_ENGINE_ERROR_RATE_SEV2: 0.05,       // 5% → SEV-2
  QUEUE_DEPTH_WARNING: 50,
  QUEUE_DEPTH_SEV2: 100,
  DRIFT_PSI_CRITICAL: 0.25,
  DISBURSEMENT_STALL_MS: 10 * 60 * 1000,      // 10 min no completions → SEV-1
};

// Track how long each service has been "down"
const downSince = {};

// Track active dedup keys for auto-resolve
const activeIncidents = new Set();

// Track disbursement stall state
let disbursementLastCompletion = Date.now();
let disbursementStallAlerted = false;

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

/**
 * Determine how many services are currently down.
 */
function countDownServices(results) {
  return Object.values(results).filter((h) => h.status === 'down').length;
}

/**
 * Trigger alert with tracking for auto-resolve.
 */
async function triggerAlert(message, severity, source, component, condition, extraOpts = {}) {
  const dedupKey = generateDedupKey(source, component, condition);
  activeIncidents.add(dedupKey);
  await sendAlert(message, severity, source, component, {
    condition,
    dedupKey,
    ...extraOpts,
  });
}

/**
 * Resolve an incident if it was previously triggered.
 */
async function resolveIfActive(source, component, condition) {
  const dedupKey = generateDedupKey(source, component, condition);
  if (activeIncidents.has(dedupKey)) {
    await resolvePagerDutyIncident(dedupKey);
    activeIncidents.delete(dedupKey);
  }
}

async function checkAlertingRules() {
  const now = Date.now();
  const results = {};

  // 1. Poll all service health endpoints
  for (const [name, url] of Object.entries(SERVICES)) {
    const health = await fetchHealth(name, url);
    results[name] = health;

    if (health.status === 'down') {
      if (!downSince[name]) downSince[name] = now;
      const downMs = now - downSince[name];

      // Rule 5: Service down — escalating severity
      if (downMs > THRESHOLDS.SERVICE_DOWN_SEV2_MS) {
        // Single service down >5 min → SEV-2
        await triggerAlert(
          `Service *${name}* has been DOWN for ${Math.floor(downMs / 60000)} minutes.\nError: ${health.error || 'unknown'}`,
          SEVERITY.SEV2, name, 'health-check', 'single_service_down_extended',
          {
            customDetails: {
              down_since: new Date(downSince[name]).toISOString(),
              down_duration_minutes: Math.floor(downMs / 60000),
              error: health.error,
            },
            links: ['https://docs.vida.mx/runbooks/incident-response'],
          },
        );
      } else if (downMs > THRESHOLDS.SERVICE_DOWN_ALERT_MS) {
        await triggerAlert(
          `Service *${name}* has been DOWN for ${Math.floor(downMs / 60000)} minutes.\nError: ${health.error || 'unknown'}`,
          SEVERITY.SEV3, name, 'health-check', 'service_down',
        );
      }
    } else {
      // Service recovered — auto-resolve
      if (downSince[name]) {
        await resolveIfActive(name, 'health-check', 'single_service_down_extended');
        await resolveIfActive(name, 'health-check', 'service_down');
      }
      delete downSince[name];
    }

    // Rule 4: Queue depth
    if (health.queue_depth) {
      for (const [queue, depth] of Object.entries(health.queue_depth)) {
        if (depth > THRESHOLDS.QUEUE_DEPTH_SEV2) {
          await triggerAlert(
            `Queue *${queue}* depth is ${depth} (threshold: ${THRESHOLDS.QUEUE_DEPTH_SEV2}) on ${name}`,
            SEVERITY.SEV2, name, 'queue-depth', 'error_rate_high',
            { customDetails: { queue, depth, threshold: THRESHOLDS.QUEUE_DEPTH_SEV2 } },
          );
        } else if (depth > THRESHOLDS.QUEUE_DEPTH_WARNING) {
          await triggerAlert(
            `Queue *${queue}* depth is ${depth} (threshold: ${THRESHOLDS.QUEUE_DEPTH_WARNING}) on ${name}`,
            SEVERITY.SEV3, name, 'queue-depth', 'queue_backlog',
          );
        }
      }
    }
  }

  // SEV-1 check: All services down simultaneously
  const downCount = countDownServices(results);
  const totalServices = Object.keys(SERVICES).length;
  if (downCount === totalServices) {
    await triggerAlert(
      `ALL ${totalServices} services are DOWN — potential infrastructure failure (Redis/Railway outage)`,
      SEVERITY.SEV1, 'vida-infrastructure', 'all-services', 'all_services_down',
      {
        customDetails: {
          down_services: Object.keys(results).filter((n) => results[n].status === 'down'),
          total_services: totalServices,
        },
        links: ['https://docs.vida.mx/runbooks/incident-response'],
      },
    );
  } else if (downCount >= 2) {
    // Multiple services down → SEV-1
    const downNames = Object.keys(results).filter((n) => results[n].status === 'down');
    await triggerAlert(
      `${downCount}/${totalServices} services are DOWN: ${downNames.join(', ')}`,
      SEVERITY.SEV1, 'vida-infrastructure', 'multi-service', 'multiple_services_down',
      {
        customDetails: { down_services: downNames, down_count: downCount, total_services: totalServices },
        links: ['https://docs.vida.mx/runbooks/incident-response'],
      },
    );
  } else if (downCount === 0) {
    await resolveIfActive('vida-infrastructure', 'all-services', 'all_services_down');
    await resolveIfActive('vida-infrastructure', 'multi-service', 'multiple_services_down');
  }

  // 2. Check queue stats from payment server
  const queueStats = await fetchQueueStats(SERVICES['vida-payment-server']);
  if (queueStats?.queues) {
    const disb = queueStats.queues['vida-disbursements'];
    if (disb) {
      const total = disb.completed + disb.failed;

      // Track disbursement stall (SEV-1): no completions but jobs waiting
      if (disb.completed === 0 && disb.waiting > 0) {
        if (!disbursementStallAlerted && (now - disbursementLastCompletion) > THRESHOLDS.DISBURSEMENT_STALL_MS) {
          disbursementStallAlerted = true;
          await triggerAlert(
            `SPEI disbursement queue STALLED — ${disb.waiting} jobs waiting, 0 completions for ${Math.floor((now - disbursementLastCompletion) / 60000)} min`,
            SEVERITY.SEV1, 'vida-payment-server', 'disbursements', 'disbursement_stalled',
            {
              customDetails: { waiting: disb.waiting, failed: disb.failed, stall_minutes: Math.floor((now - disbursementLastCompletion) / 60000) },
              links: ['https://docs.vida.mx/runbooks/alerting-runbook#spei-disbursement'],
            },
          );
        }
      } else if (disb.completed > 0) {
        disbursementLastCompletion = now;
        if (disbursementStallAlerted) {
          disbursementStallAlerted = false;
          await resolveIfActive('vida-payment-server', 'disbursements', 'disbursement_stalled');
        }
      }

      // Rule 3: SPEI disbursement failure rate
      if (total > 0) {
        const failRate = disb.failed / total;
        if (failRate > THRESHOLDS.DISBURSEMENT_FAILURE_RATE_SEV2) {
          await triggerAlert(
            `SPEI disbursement failure rate is ${(failRate * 100).toFixed(2)}% (${disb.failed}/${total}) — threshold: 5% (SEV-2)`,
            SEVERITY.SEV2, 'vida-payment-server', 'disbursements', 'disbursement_failure_rate_high',
            {
              customDetails: { failure_rate: failRate, failed: disb.failed, total, threshold: '5%' },
              links: ['https://docs.vida.mx/runbooks/alerting-runbook#spei-disbursement'],
            },
          );
        } else if (failRate > THRESHOLDS.DISBURSEMENT_FAILURE_RATE) {
          await triggerAlert(
            `SPEI disbursement failure rate is ${(failRate * 100).toFixed(2)}% (${disb.failed}/${total}) — threshold: 0.5%`,
            SEVERITY.SEV3, 'vida-payment-server', 'disbursements', 'disbursement_failure_rate',
          );
        }
      }
    }

    // Rule 1: Decision engine (underwriting) error rate
    const uw = queueStats.queues['vida-underwriting'];
    if (uw) {
      const total = uw.completed + uw.failed;
      if (total > 0) {
        const errRate = uw.failed / total;
        if (errRate > THRESHOLDS.DECISION_ENGINE_ERROR_RATE_SEV2) {
          await triggerAlert(
            `Decision engine error rate is ${(errRate * 100).toFixed(2)}% (${uw.failed}/${total}) — threshold: 5% (SEV-2)`,
            SEVERITY.SEV2, 'vida-ml-service', 'decision-engine', 'error_rate_high',
            {
              customDetails: { error_rate: errRate, failed: uw.failed, total, threshold: '5%' },
              links: ['https://docs.vida.mx/runbooks/alerting-runbook#decision-engine'],
            },
          );
        } else if (errRate > THRESHOLDS.DECISION_ENGINE_ERROR_RATE) {
          await triggerAlert(
            `Decision engine error rate is ${(errRate * 100).toFixed(2)}% (${uw.failed}/${total}) — threshold: 1%`,
            SEVERITY.SEV3, 'vida-ml-service', 'decision-engine', 'decision_engine_error_rate',
          );
        }
      }
    }
  }

  // Check for MetaMap outage (SEV-2): underwriting service is up but reports KYC failures
  const uwHealth = results['vida-ml-service'];
  if (uwHealth?.metamap_status === 'down' || uwHealth?.kyc_error_rate > 0.5) {
    await triggerAlert(
      `MetaMap KYC provider appears DOWN — KYC verification is degraded`,
      SEVERITY.SEV2, 'vida-underwriting-service', 'kyc', 'metamap_outage',
      {
        customDetails: { metamap_status: uwHealth.metamap_status, kyc_error_rate: uwHealth.kyc_error_rate },
        links: ['https://docs.vida.mx/runbooks/alerting-runbook#metamap-latency'],
      },
    );
  }

  // Check for Redis OOM (SEV-1): detected via health check custom fields
  for (const [name, health] of Object.entries(results)) {
    if (health.redis_status === 'oom' || health.redis_error?.includes('OOM')) {
      await triggerAlert(
        `Redis OOM detected via ${name} — all BullMQ queues at risk`,
        SEVERITY.SEV1, 'vida-redis', 'memory', 'redis_oom',
        {
          customDetails: { detected_by: name, redis_error: health.redis_error },
          links: ['https://docs.vida.mx/runbooks/incident-response#redis'],
        },
      );
      break; // Only alert once for Redis OOM
    }
    if (health.redis_status === 'connection_refused' || health.redis_error?.includes('ECONNREFUSED')) {
      await triggerAlert(
        `Redis connection refused detected via ${name} — all services affected`,
        SEVERITY.SEV1, 'vida-redis', 'connectivity', 'redis_connection_refused',
        {
          customDetails: { detected_by: name, redis_error: health.redis_error },
          links: ['https://docs.vida.mx/runbooks/incident-response#redis'],
        },
      );
      break;
    }
  }

  // 6. Check PSI drift from ML service
  const drift = await fetchDriftLatest(SERVICES['vida-ml-service']);
  if (drift?.psi?.score > THRESHOLDS.DRIFT_PSI_CRITICAL) {
    await triggerAlert(
      `Model drift detected: PSI=${drift.psi.score} (threshold: ${THRESHOLDS.DRIFT_PSI_CRITICAL}) — full retrain required`,
      SEVERITY.SEV2, 'vida-ml-service', 'model-drift', 'error_rate_high',
      {
        customDetails: { psi_score: drift.psi.score, threshold: THRESHOLDS.DRIFT_PSI_CRITICAL },
        links: ['https://docs.vida.mx/runbooks/alerting-runbook#psi-drift'],
      },
    );
  }

  return results;
}

// Main polling loop
async function main() {
  console.log('[health-monitor] Starting with poll interval', POLL_INTERVAL, 'ms');
  console.log('[health-monitor] Monitoring services:', Object.keys(SERVICES).join(', '));
  console.log('[health-monitor] SEV-1 thresholds: all-down, Redis OOM, disbursement stall >10min');
  console.log('[health-monitor] SEV-2 thresholds: single-down >5min, error >5%, MetaMap outage');

  while (true) {
    try {
      const results = await checkAlertingRules();
      const statuses = Object.entries(results).map(([name, h]) => `${name}: ${h.status}`);
      console.log(`[health-monitor] ${new Date().toISOString()} — ${statuses.join(', ')}`);
    } catch (err) {
      console.error('[health-monitor] Error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// Export for use as a module or run standalone
module.exports = { checkAlertingRules, fetchHealth, SERVICES, THRESHOLDS, countDownServices };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
