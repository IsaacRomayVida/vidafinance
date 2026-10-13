/**
 * Load Test Configuration
 *
 * Environment variables (set before running):
 *   TARGET_URL         — Functions base URL of a NON-production target. No default.
 *                        Emulator: http://127.0.0.1:5011/demo-vida-load/us-central1
 *                        Staging:  https://us-central1-<STAGING_PROJECT>.cloudfunctions.net
 *                        (STAGING_URL is the old name and is still read. Production
 *                        hosts are refused — see ./target.js.)
 *   FIREBASE_API_KEY   — Firebase Web API key for the target project
 *   INTERNAL_SECRET    — Shared internal secret for service-to-service auth
 *
 * Mock mode env vars (set on staging services):
 *   METAMAP_MOCK=true, RISKSEAL_MOCK=true
 */

// ── Ramp stages ─────────────────────────────────────────────────────────────
// Each stage runs for 30 minutes at specified rate.
// Target: 140 apps/hour = ~2.33/min at 100K/month
// 2x target: 280 apps/hour = ~4.67/min

export const RAMP_STAGES = [
  { target: 10,  duration: '30m', label: 'warmup'   },  // 10/min  — warmup
  { target: 50,  duration: '30m', label: 'ramp1'    },  // 50/min  — moderate
  { target: 140, duration: '30m', label: 'target'   },  // 140/min — 100K/month target
  { target: 280, duration: '30m', label: '2x_target' }, // 280/min — 2x stress
];

// Quick smoke-test profile (5 min total)
export const SMOKE_STAGES = [
  { target: 5,  duration: '1m', label: 'warmup' },
  { target: 20, duration: '2m', label: 'ramp'   },
  { target: 50, duration: '2m', label: 'peak'   },
];

// ── Thresholds ──────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  // End-to-end request latency
  'http_req_duration{type:requestLoan}': [
    'p(50)<5000',   // P50 < 5s
    'p(95)<30000',  // P95 < 30s (acceptance criteria)
    'p(99)<60000',  // P99 < 60s
  ],
  // Error rate
  'http_req_failed{type:requestLoan}': ['rate<0.01'], // <1% error rate
  // Custom stage latencies. These trends only receive samples when the target
  // sends X-Stage-*-Ms headers, which no function does today — until then the
  // three thresholds below pass with no data and prove nothing.
  'stage_latency_validation': ['p(95)<1000'],
  'stage_latency_firestore_write': ['p(95)<3000'],
  'stage_latency_queue_dispatch': ['p(95)<2000'],
};

// ── Borrower profiles ───────────────────────────────────────────────────────

export const BORROWER_PROFILES = {
  good: {
    weight: 0.5,
    salary: { min: 15000, max: 40000 },
    tenure: { min: 12, max: 60 },
    amount: { min: 500, max: 2000 },
    kycStatus: 'verified',
  },
  medium: {
    weight: 0.3,
    salary: { min: 8000, max: 15000 },
    tenure: { min: 6, max: 18 },
    amount: { min: 1000, max: 3000 },
    kycStatus: 'verified',
  },
  risky: {
    weight: 0.2,
    salary: { min: 5000, max: 10000 },
    tenure: { min: 3, max: 6 },
    amount: { min: 2000, max: 5000 },
    kycStatus: 'verified',
  },
};

// ── Employer pool ───────────────────────────────────────────────────────────

export const EMPLOYER_CODES = [
  'VIDA01', 'VIDA02', 'VIDA03', 'VIDA04', 'VIDA05',
  'VIDA06', 'VIDA07', 'VIDA08', 'VIDA09', 'VIDA10',
];

export const LOAN_PURPOSES = [
  'emergency', 'medical', 'education',
  'home_repair', 'transportation', 'debt_consolidation', 'other',
];

// ── Valid CLABE numbers for load testing ─────────────────────────────────────
// Pre-computed valid CLABEs with correct checksums (bank 012 = BBVA)

export const TEST_CLABES = [
  '012180340056604044',
  '012180863293097043',
  '012180930089877960',
  '012180255894952739',
  '012180557702080051',
];
