"use strict";
/**
 * employer-a.js — Employer Part A: automated screening (~30s, ~$1-3 MXN).
 *
 * Runs 5 checks in parallel via Promise.allSettled():
 *   1. SAT Active Status    (verifik)
 *   2. Lista 69-B / EFOS    (sw-client)
 *   3. Art. 69 Fiscal Debt  (sw-client)
 *   4. DENUE Business Reg.  (gov-apis)
 *   5. REPSE Labor Compl.   (gov-apis)
 *
 * Decision rules:
 *   - 69-B DEFINITIVO → hard reject, no appeal
 *   - 69-B PRESUNTO   → flag for Part B investigation
 *   - Any API failure  → degrade gracefully, continue with available signals
 *
 * Results cached in Redis for 24h keyed by RFC.
 */
const redis   = require("../redis-client");
const { checkSATTaxpayer } = require("../verifik");
const { check69B, checkArt69 } = require("../sw-client");
const { checkDENUE, checkREPSE } = require("../gov-apis");

const STAGE_CACHE_TTL = 86400; // 24 h

/**
 * Extract a result from a Promise.allSettled outcome.
 * Fulfilled → value; Rejected → graceful degradation stub.
 */
function extractResult(settled, checkName) {
  if (settled.status === "fulfilled") return settled.value;
  console.warn(`[employer-a] ${checkName} failed: ${settled.reason?.message || settled.reason}`);
  return { pass: true, skipped: true, error: String(settled.reason?.message || settled.reason) };
}

/**
 * Run the full Employer Part A screening.
 *
 * @param {{ rfc: string, companyName: string, stateCode?: string }} employer
 * @returns {Promise<{ pass: boolean, hardReject: boolean, reason: string|null, signals: Object, cost: number, durationMs: number }>}
 */
async function runEmployerScreening(employer) {
  const { rfc, companyName, stateCode } = employer;
  const start = Date.now();

  // ── Check stage-level cache ──────────────────────────────────────────
  const cacheKey = `employer-a:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  // ── Run all 5 checks in parallel ────────────────────────────────────
  const [satResult, lista69BResult, art69Result, denueResult, repseResult] =
    await Promise.allSettled([
      checkSATTaxpayer(rfc),
      check69B(rfc),
      checkArt69(rfc),
      checkDENUE(companyName, stateCode || "00"),
      checkREPSE(rfc),
    ]);

  const sat     = extractResult(satResult, "SAT");
  const lista69B = extractResult(lista69BResult, "69-B");
  const art69   = extractResult(art69Result, "Art.69");
  const denue   = extractResult(denueResult, "DENUE");
  const repse   = extractResult(repseResult, "REPSE");

  const signals = { sat, lista69B, art69, denue, repse };

  // ── Decision logic ──────────────────────────────────────────────────
  // DEFINITIVO on 69-B = immediate hard reject
  if (lista69B.hardReject) {
    const result = {
      pass: false,
      hardReject: true,
      reason: "lista_69b_definitivo",
      signals,
      cost: 1,
      durationMs: Date.now() - start,
    };
    await redis.set(cacheKey, JSON.stringify(result), "EX", STAGE_CACHE_TTL).catch(() => {});
    return result;
  }

  // Aggregate non-skipped failures
  const failures = [];
  if (!sat.pass && !sat.skipped)     failures.push("sat_inactive");
  if (!lista69B.pass && !lista69B.skipped && !lista69B.flag) failures.push("lista_69b_fail");
  if (!art69.pass && !art69.skipped) failures.push("art69_fiscal_debt");
  if (!denue.pass && !denue.skipped) failures.push("denue_not_found");
  // REPSE not passing is a flag, not a hard fail (only required for outsourcing)
  if (!repse.pass && !repse.skipped) failures.push("repse_not_registered");

  const pass = failures.length === 0;
  const reason = pass ? null : failures[0];

  const result = {
    pass,
    hardReject: false,
    reason,
    signals,
    cost: 1,
    durationMs: Date.now() - start,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", STAGE_CACHE_TTL).catch(() => {});
  return result;
}

module.exports = { runEmployerScreening };
