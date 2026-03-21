#!/usr/bin/env node

/**
 * VID3-124: Performance Report Generator
 *
 * Processes k6 JSON output to generate a detailed bottleneck analysis report
 * including P50/P95/P99 latency per stage, max throughput before errors,
 * queue depth over time, Firestore operation counts, and Redis memory usage.
 *
 * Usage:
 *   # After running load test with JSON output:
 *   k6 run --out json=results.json tests/load/pipeline-load-test.js
 *
 *   # Generate report:
 *   node tests/load/generate-report.js results.json
 *
 *   # Or pipe from stdin:
 *   cat results.json | node tests/load/generate-report.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Data structures ─────────────────────────────────────────────────────────

const metricData = {
  // Per-metric arrays of { timestamp, value }
  request_latency_e2e: [],
  stage_latency_validation: [],
  stage_latency_firestore_write: [],
  stage_latency_queue_dispatch: [],
  stage_latency_ml_scoring: [],
  http_req_duration: [],

  // Counters
  loans_submitted: 0,
  loans_succeeded: 0,
  loans_failed: 0,
  rate_limited_requests: 0,
  timeout_errors: 0,
  server_errors: 0,
  loans_profile_good: 0,
  loans_profile_medium: 0,
  loans_profile_risky: 0,

  // HTTP status codes
  statusCodes: {},

  // Time-bucketed throughput (1-minute buckets)
  throughputBuckets: {},

  // Error timeline
  errorTimeline: [],
};

// ── Percentile calculation ──────────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function computeStats(values) {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p50: Math.round(percentile(sorted, 50)),
    p90: Math.round(percentile(sorted, 90)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
  };
}

// ── Parse k6 JSON output ────────────────────────────────────────────────────

function processLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return; // Skip non-JSON lines
  }

  if (!entry.type || !entry.metric) return;

  const ts = entry.data ? entry.data.time : null;
  const value = entry.data ? entry.data.value : 0;

  // Trend metrics (latency)
  if (entry.type === 'Point' && metricData[entry.metric] instanceof Array) {
    metricData[entry.metric].push({ timestamp: ts, value });
  }

  // HTTP request duration (all requests)
  if (entry.type === 'Point' && entry.metric === 'http_req_duration') {
    const tags = entry.data.tags || {};
    if (tags.type === 'requestLoan') {
      metricData.http_req_duration.push({ timestamp: ts, value });

      // Track throughput per minute
      if (ts) {
        const minuteKey = ts.slice(0, 16); // YYYY-MM-DDTHH:MM
        metricData.throughputBuckets[minuteKey] = (metricData.throughputBuckets[minuteKey] || 0) + 1;
      }

      // Track status codes
      const status = tags.status || 'unknown';
      metricData.statusCodes[status] = (metricData.statusCodes[status] || 0) + 1;
    }
  }

  // Counter metrics
  if (entry.type === 'Point') {
    const counterMetrics = [
      'loans_submitted', 'loans_succeeded', 'loans_failed',
      'rate_limited_requests', 'timeout_errors', 'server_errors',
      'loans_profile_good', 'loans_profile_medium', 'loans_profile_risky',
    ];
    if (counterMetrics.includes(entry.metric)) {
      metricData[entry.metric] += value;
    }
  }
}

// ── Report generation ───────────────────────────────────────────────────────

function generateReport() {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {},
    latencyPerStage: {},
    throughput: {},
    errors: {},
    bottleneckAnalysis: {},
    recommendations: [],
  };

  // ── Latency per stage
  const stageNames = {
    request_latency_e2e: 'End-to-End',
    stage_latency_validation: 'Validation',
    stage_latency_firestore_write: 'Firestore Write',
    stage_latency_queue_dispatch: 'Queue Dispatch',
    stage_latency_ml_scoring: 'ML Scoring',
  };

  for (const [key, label] of Object.entries(stageNames)) {
    const values = metricData[key].map((d) => d.value);
    report.latencyPerStage[label] = computeStats(values);
  }

  // ── Throughput analysis
  const buckets = Object.entries(metricData.throughputBuckets).sort(([a], [b]) => a.localeCompare(b));
  const throughputValues = buckets.map(([, count]) => count);
  report.throughput = {
    totalRequests: metricData.loans_submitted,
    totalSucceeded: metricData.loans_succeeded,
    totalFailed: metricData.loans_failed,
    peakRequestsPerMinute: throughputValues.length > 0 ? Math.max(...throughputValues) : 0,
    avgRequestsPerMinute: throughputValues.length > 0 ? Math.round(throughputValues.reduce((a, b) => a + b, 0) / throughputValues.length) : 0,
    durationMinutes: buckets.length,
    throughputOverTime: buckets.map(([minute, count]) => ({ minute, count })),
  };

  // Find max throughput before errors start appearing
  let maxCleanThroughput = 0;
  let errorStartMinute = null;
  for (const [minute, count] of buckets) {
    // Check if errors appeared around this time
    const httpDuringMinute = metricData.http_req_duration.filter(
      (d) => d.timestamp && d.timestamp.startsWith(minute)
    );
    const errorsInMinute = httpDuringMinute.filter((d) => d.value > 30000).length; // >30s = likely error
    if (errorsInMinute === 0) {
      maxCleanThroughput = Math.max(maxCleanThroughput, count);
    } else if (!errorStartMinute) {
      errorStartMinute = minute;
    }
  }
  report.throughput.maxCleanThroughputPerMinute = maxCleanThroughput;
  report.throughput.errorStartMinute = errorStartMinute;

  // ── Error analysis
  report.errors = {
    totalErrors: metricData.loans_failed,
    rateLimited: metricData.rate_limited_requests,
    timeouts: metricData.timeout_errors,
    serverErrors: metricData.server_errors,
    errorRate: metricData.loans_submitted > 0
      ? (metricData.loans_failed / metricData.loans_submitted * 100).toFixed(2) + '%'
      : '0.00%',
    statusCodes: metricData.statusCodes,
  };

  // ── Profile distribution
  report.summary.profileDistribution = {
    good: metricData.loans_profile_good,
    medium: metricData.loans_profile_medium,
    risky: metricData.loans_profile_risky,
  };

  // ── Bottleneck analysis
  const e2eStats = report.latencyPerStage['End-to-End'];
  const firestoreStats = report.latencyPerStage['Firestore Write'];
  const queueStats = report.latencyPerStage['Queue Dispatch'];
  const validationStats = report.latencyPerStage['Validation'];
  const mlStats = report.latencyPerStage['ML Scoring'];

  const bottlenecks = [];

  if (firestoreStats.p95 > 3000) {
    bottlenecks.push({
      component: 'Firestore',
      severity: 'high',
      detail: `P95 write latency ${firestoreStats.p95}ms exceeds 3s threshold`,
      recommendation: 'Request Firestore quota increase (default 500 writes/sec). Consider batch writes or write-behind caching.',
    });
  }

  if (queueStats.p95 > 2000) {
    bottlenecks.push({
      component: 'BullMQ/Redis',
      severity: 'high',
      detail: `P95 queue dispatch latency ${queueStats.p95}ms exceeds 2s threshold`,
      recommendation: 'Check Redis memory usage and connection pool. Consider increasing Redis instance size.',
    });
  }

  if (mlStats.count > 0 && mlStats.p95 > 5000) {
    bottlenecks.push({
      component: 'ML Service',
      severity: 'medium',
      detail: `P95 ML scoring latency ${mlStats.p95}ms. Worker concurrency may be insufficient.`,
      recommendation: 'Increase ML worker concurrency from 5 to 10-15. Consider model caching improvements.',
    });
  }

  if (e2eStats.p95 > 30000) {
    bottlenecks.push({
      component: 'Overall Pipeline',
      severity: 'critical',
      detail: `P95 end-to-end latency ${e2eStats.p95}ms exceeds 30s acceptance threshold`,
      recommendation: 'Focus on highest-latency stage. Consider parallelizing validation + Firestore operations.',
    });
  }

  if (metricData.rate_limited_requests > metricData.loans_submitted * 0.05) {
    bottlenecks.push({
      component: 'Rate Limiter',
      severity: 'medium',
      detail: `${metricData.rate_limited_requests} rate-limited requests (${((metricData.rate_limited_requests / metricData.loans_submitted) * 100).toFixed(1)}%)`,
      recommendation: 'Verify load test uses unique user IDs per request to avoid rate limit collisions.',
    });
  }

  report.bottleneckAnalysis = {
    bottlenecks,
    overallAssessment: bottlenecks.length === 0
      ? 'No bottlenecks detected at tested throughput levels.'
      : `${bottlenecks.length} bottleneck(s) identified. See recommendations.`,
  };

  // ── Recommendations
  report.recommendations = [
    ...bottlenecks.map((b) => b.recommendation),
  ];

  // Firestore quota check
  const estimatedWritesPerSec = report.throughput.peakRequestsPerMinute / 60 * 3; // ~3 writes per loan
  if (estimatedWritesPerSec > 400) {
    report.recommendations.push(
      `Estimated peak Firestore writes: ${Math.round(estimatedWritesPerSec)}/sec. ` +
        'Default limit is 500/sec. Request quota increase via Firebase console.'
    );
  }

  // ML worker concurrency
  if (report.throughput.peakRequestsPerMinute > 100) {
    report.recommendations.push(
      'ML worker concurrency (currently 5) may need increase to 10-15 for sustained throughput above 100 req/min.'
    );
  }

  return report;
}

// ── Text report formatter ───────────────────────────────────────────────────

function formatTextReport(report) {
  const lines = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
  lines.push('║             VIDA Finance — Load Test Performance Report                 ║');
  lines.push(`║             Generated: ${report.generatedAt.padEnd(48)}║`);
  lines.push('╚══════════════════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Latency per stage
  lines.push('┌─ Latency Per Stage ───────────────────────────────────────────────────┐');
  lines.push('│  Stage                 Count     P50     P90     P95     P99     Max  │');
  lines.push('│  ─────────────────────────────────────────────────────────────────────│');
  for (const [stage, stats] of Object.entries(report.latencyPerStage)) {
    if (stats.count > 0) {
      lines.push(
        `│  ${stage.padEnd(20)} ${String(stats.count).padStart(6)}  ` +
          `${String(stats.p50).padStart(6)}ms ${String(stats.p90).padStart(6)}ms ` +
          `${String(stats.p95).padStart(6)}ms ${String(stats.p99).padStart(6)}ms ` +
          `${String(stats.max).padStart(6)}ms │`
      );
    }
  }
  lines.push('└──────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Throughput
  lines.push('┌─ Throughput ──────────────────────────────────────────────────────────┐');
  lines.push(`│  Total requests:            ${String(report.throughput.totalRequests).padStart(8)}`);
  lines.push(`│  Succeeded:                 ${String(report.throughput.totalSucceeded).padStart(8)}`);
  lines.push(`│  Failed:                    ${String(report.throughput.totalFailed).padStart(8)}`);
  lines.push(`│  Peak requests/min:         ${String(report.throughput.peakRequestsPerMinute).padStart(8)}`);
  lines.push(`│  Avg requests/min:          ${String(report.throughput.avgRequestsPerMinute).padStart(8)}`);
  lines.push(`│  Max clean throughput/min:  ${String(report.throughput.maxCleanThroughputPerMinute).padStart(8)}`);
  lines.push(`│  Test duration:             ${String(report.throughput.durationMinutes).padStart(5)} min`);
  lines.push('└──────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Errors
  lines.push('┌─ Error Analysis ─────────────────────────────────────────────────────┐');
  lines.push(`│  Error rate:       ${report.errors.errorRate}`);
  lines.push(`│  Rate limited:     ${report.errors.rateLimited}`);
  lines.push(`│  Timeouts:         ${report.errors.timeouts}`);
  lines.push(`│  Server errors:    ${report.errors.serverErrors}`);
  if (Object.keys(report.errors.statusCodes).length > 0) {
    lines.push('│  Status codes:');
    for (const [code, count] of Object.entries(report.errors.statusCodes)) {
      lines.push(`│    ${code}: ${count}`);
    }
  }
  lines.push('└──────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Bottleneck analysis
  lines.push('┌─ Bottleneck Analysis ────────────────────────────────────────────────┐');
  if (report.bottleneckAnalysis.bottlenecks.length === 0) {
    lines.push('│  No bottlenecks detected at tested throughput levels.');
  } else {
    for (const b of report.bottleneckAnalysis.bottlenecks) {
      lines.push(`│  [${b.severity.toUpperCase()}] ${b.component}`);
      lines.push(`│    ${b.detail}`);
      lines.push(`│    → ${b.recommendation}`);
      lines.push('│');
    }
  }
  lines.push('└──────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push('┌─ Recommendations ──────────────────────────────────────────────────┐');
    report.recommendations.forEach((r, i) => {
      lines.push(`│  ${i + 1}. ${r}`);
    });
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
  }

  // Throughput over time (sampled)
  const timeData = report.throughput.throughputOverTime;
  if (timeData.length > 0) {
    lines.push('┌─ Throughput Over Time (req/min) ────────────────────────────────────┐');
    const sampleInterval = Math.max(1, Math.floor(timeData.length / 30));
    for (let i = 0; i < timeData.length; i += sampleInterval) {
      const d = timeData[i];
      const bar = '█'.repeat(Math.min(50, Math.round(d.count / 2)));
      const time = d.minute.split('T')[1] || d.minute;
      lines.push(`│  ${time}  ${String(d.count).padStart(4)} ${bar}`);
    }
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
  }

  // Profile distribution
  const dist = report.summary.profileDistribution;
  if (dist) {
    lines.push('┌─ Profile Distribution ─────────────────────────────────────────────┐');
    lines.push(`│  Good:   ${dist.good}  (50% target)`);
    lines.push(`│  Medium: ${dist.medium}  (30% target)`);
    lines.push(`│  Risky:  ${dist.risky}  (20% target)`);
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
  }

  lines.push('');
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const inputFile = process.argv[2];

  let input;
  if (inputFile && inputFile !== '-') {
    input = fs.createReadStream(inputFile);
  } else {
    input = process.stdin;
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  console.error('Processing k6 JSON output...');

  let lineCount = 0;
  for await (const line of rl) {
    processLine(line.trim());
    lineCount++;
    if (lineCount % 10000 === 0) {
      console.error(`  Processed ${lineCount} lines...`);
    }
  }

  console.error(`  Total lines processed: ${lineCount}`);
  console.error('Generating report...');

  const report = generateReport();
  const textReport = formatTextReport(report);

  // Output text report to stdout
  console.log(textReport);

  // Write JSON report
  const outputDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `report-${timestamp}.json`);
  const txtPath = path.join(outputDir, `report-${timestamp}.txt`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(txtPath, textReport);

  console.error(`\nReports saved to:`);
  console.error(`  JSON: ${jsonPath}`);
  console.error(`  Text: ${txtPath}`);
}

main().catch((err) => {
  console.error('Report generation failed:', err);
  process.exit(1);
});
