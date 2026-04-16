/**
 * shared/metrics.js
 *
 * Prometheus metrics middleware for Node/Express services.
 * Exposes /metrics endpoint + default Node process metrics + custom counters.
 *
 * Usage:
 *   const { register, metricsMiddleware, httpDuration, businessEvent } = require('../shared/metrics');
 *   app.use(metricsMiddleware('my-service'));
 *   app.get('/metrics', async (req, res) => {
 *     res.set('Content-Type', register.contentType);
 *     res.end(await register.metrics());
 *   });
 *
 * Increment business events:
 *   businessEvent('loan_disbursed', { employer: 'Acme' });
 *   businessEvent('disbursement_failed', { reason: 'softcredito_500' });
 */

const client = require('prom-client');

const register = new client.Registry();

// Default Node metrics: CPU, memory, event loop, GC
client.collectDefaultMetrics({ register, prefix: 'vida_' });

// HTTP request histogram
const httpDuration = new client.Histogram({
  name: 'vida_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['service', 'method', 'path', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Business event counter
const businessEventCounter = new client.Counter({
  name: 'vida_business_events_total',
  help: 'Count of business-level events (loan_disbursed, repayment_received, etc.)',
  labelNames: ['event', 'service'],
  registers: [register],
});

// Queue depth gauge
const queueDepth = new client.Gauge({
  name: 'vida_queue_depth',
  help: 'Current BullMQ queue depth',
  labelNames: ['queue', 'state'],
  registers: [register],
});

// External provider latency
const providerLatency = new client.Histogram({
  name: 'vida_external_provider_duration_seconds',
  help: 'Latency of external provider calls',
  labelNames: ['provider', 'endpoint', 'outcome'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Circuit breaker state
const circuitBreakerState = new client.Gauge({
  name: 'vida_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['provider'],
  registers: [register],
});

/**
 * Express middleware that records request duration per route.
 */
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      // Normalize path to avoid cardinality explosion — use route if available
      const path = (req.route && req.route.path) || req.path.replace(/\/[a-f0-9\-]{8,}/gi, '/:id');
      httpDuration.observe(
        { service: serviceName, method: req.method, path, status_code: String(res.statusCode) },
        durationSec,
      );
    });
    next();
  };
}

/**
 * Increment a business event counter.
 * @param {string} event - e.g. 'loan_disbursed', 'disbursement_failed'
 * @param {string} service - service name
 */
function businessEvent(event, service) {
  businessEventCounter.inc({ event, service });
}

/**
 * Record external provider call latency.
 */
function recordProviderCall(provider, endpoint, outcome, durationSec) {
  providerLatency.observe({ provider, endpoint, outcome }, durationSec);
}

/**
 * Set circuit breaker state.
 */
function setCircuitState(provider, state) {
  const val = state === 'open' ? 2 : state === 'half-open' ? 1 : 0;
  circuitBreakerState.set({ provider }, val);
}

module.exports = {
  register,
  metricsMiddleware,
  businessEvent,
  recordProviderCall,
  setCircuitState,
  queueDepth,
  httpDuration,
};

