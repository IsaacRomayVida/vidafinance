/**
 * Synthetic data generators for load testing.
 *
 * Generates realistic loan application payloads with varied borrower profiles
 * (good, medium, risky) weighted by configured distribution.
 */

import { BORROWER_PROFILES, EMPLOYER_CODES, LOAN_PURPOSES, TEST_CLABES } from '../config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function roundTo100(n) {
  return Math.round(n / 100) * 100;
}

/**
 * Select a borrower profile based on configured weights.
 * @returns {string} Profile key: 'good', 'medium', or 'risky'
 */
function selectProfile() {
  const r = Math.random();
  let cumulative = 0;
  for (const [key, profile] of Object.entries(BORROWER_PROFILES)) {
    cumulative += profile.weight;
    if (r <= cumulative) return key;
  }
  return 'good';
}

/**
 * Compute a valid CLABE check digit for the first 17 digits.
 * Mexican CLABE: 18 digits, check digit = (10 - (weighted_sum % 10)) % 10
 * Weights cycle: [3, 7, 1]
 */
function computeClabeCheckDigit(first17) {
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(first17[i], 10) * weights[i % 3];
  }
  return ((10 - (sum % 10)) % 10).toString();
}

/**
 * Generate a valid random CLABE (18 digits with valid checksum).
 * CLABE format: 3 bank + 3 locality + 11 account + 1 check = 18 digits.
 * Uses bank code 012 (BBVA).
 */
export function generateClabe() {
  // Use a pre-computed valid CLABE most of the time for reliability
  if (Math.random() < 0.8) {
    return randElement(TEST_CLABES);
  }
  // Generate a fresh valid CLABE
  const bank = '012';
  const locality = String(randInt(100, 999));
  const account = String(randInt(10000000000, 99999999999)).padStart(11, '0');
  const first17 = (bank + locality + account).slice(0, 17);
  return first17 + computeClabeCheckDigit(first17);
}

/**
 * Generate a unique user ID for this VU iteration.
 * Uses VU number + iteration to avoid rate-limit collisions.
 * @param {number} vuId   - Virtual user ID (k6 __VU)
 * @param {number} iter   - Iteration counter (k6 __ITER)
 * @returns {string} Unique synthetic user ID
 */
export function generateUserId(vuId, iter) {
  return `loadtest-vu${vuId}-iter${iter}-${Date.now()}`;
}

/**
 * Generate a synthetic loan application payload.
 *
 * @param {number} vuId  - Virtual user ID
 * @param {number} iter  - Iteration number
 * @returns {{ payload: object, profile: string, userId: string }}
 */
export function generateLoanApplication(vuId, iter) {
  const profileKey = selectProfile();
  const profile = BORROWER_PROFILES[profileKey];

  const salary = randInt(profile.salary.min, profile.salary.max);
  const maxByPolicy = Math.min(roundTo100(salary * 0.3), 5000);
  const desiredAmount = roundTo100(randInt(profile.amount.min, profile.amount.max));
  const amount = Math.min(desiredAmount, maxByPolicy);
  // Ensure amount is at least 500 and a multiple of 100
  const finalAmount = Math.max(500, roundTo100(amount));

  const userId = generateUserId(vuId, iter);

  return {
    userId,
    profile: profileKey,
    payload: {
      amount: finalAmount,
      term: 30,
    },
    // Metadata for the test harness (used to pre-seed Firestore if needed)
    borrowerMeta: {
      monthlySalary: salary,
      employmentTenureMonths: randInt(profile.tenure.min, profile.tenure.max),
      employerCode: randElement(EMPLOYER_CODES),
      bankAccountClabe: generateClabe(),
      loanPurpose: randElement(LOAN_PURPOSES),
      kycStatus: profile.kycStatus,
    },
  };
}
