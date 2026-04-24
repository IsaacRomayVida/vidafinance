"use strict";
/**
 * Employer Part A: Screening
 *
 * All checks run in parallel. Cost: ~$1-3 MXN. Time: ~30s. ~80% pass.
 *
 * Checks:
 *   1. Lista 69-B EFOS blacklist (SW)
 *   2. Art. 69 fiscal debt (SW)
 *   3. DENUE business registry (gov-apis)
 *   4. REPSE labor compliance (gov-apis)
 *
 * Note: direct SAT taxpayer-status check was dropped 2026-04-21 after product
 * decision to standardize KYC on MetaMap. EFOS + Art. 69 are both SAT-derived
 * signals that together provide reasonable due diligence without a dedicated
 * vendor. Edge case: SAT-suspendido RFCs not on EFOS/Art69 blacklists will pass.
 * Regulatory counsel sign-off pending.
 *
 * On provider error: escalate to manual review (Stage 5). Never default to pass.
 */
const redis = require("../redis-client");
// SAT blacklist provider is flag-selected at module load.
// - "local" (default): reads self-hosted EFOS + Art. 69 CSVs from GCS
//   via sat-blacklist-client. Populated by the satBlacklistRefresh
//   Cloud Function. No vendor cost, monthly-fresh data.
// - "sw": uses the legacy SW SAPiens integration in sw-client. Kept
//   available for contingency; flip EMPLOYER_SAT_PROVIDER=sw if a SAT
//   portal outage or schema change takes the local path out of commission.
//   Requires SW_USER + SW_PASSWORD to be configured.
const EMPLOYER_SAT_PROVIDER = process.env.EMPLOYER_SAT_PROVIDER || "local";
const { check69B, checkArt69 } =
  EMPLOYER_SAT_PROVIDER === "sw"
    ? require("../sw-client")
    : require("../sat-blacklist-client");
const { checkDENUE, checkREPSE } = require("../gov-apis");

const CACHE_TTL = 86400; // 24 h

async function runEmployerScreening(employer, { logger } = {}) {
  const log = logger || console;
  const rfc = employer.rfc;
  const stateCode = employer.stateCode || "00";
  const startTime = Date.now();
  const costItems = [];

  // Return cached result if available
  const cacheKey = `employer-a:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  log.info({ stage: "employer-a", rfc }, "Starting employer screening");

  const [efosResult, art69Result, denueResult, repseResult] =
    await Promise.allSettled([
      check69B(rfc),
      checkArt69(rfc),
      checkDENUE(employer.companyName, stateCode),
      checkREPSE(rfc),
    ]);

  // On API error: pass: false, skipped: true — never silently pass
  const lista69B = efosResult.status === "fulfilled" ? efosResult.value  : { pass: false, skipped: true, error: efosResult.reason?.message };
  const art69   = art69Result.status === "fulfilled" ? art69Result.value : { pass: false, skipped: true, error: art69Result.reason?.message };
  const denue   = denueResult.status === "fulfilled" ? denueResult.value : { pass: false, skipped: true, error: denueResult.reason?.message };
  const repse   = repseResult.status === "fulfilled" ? repseResult.value : { pass: false, skipped: true, error: repseResult.reason?.message };

  // Log full details for every skipped check so failures are never swallowed.
  // The api label reflects which provider actually ran, for ops debuggability.
  const efosApi = EMPLOYER_SAT_PROVIDER === "sw" ? "sw-69b" : "sat-local-69b";
  const art69Api = EMPLOYER_SAT_PROVIDER === "sw" ? "sw-art69" : "sat-local-art69";
  const skippedChecks = [];
  if (lista69B.skipped) { log.error({ stage: "employer-a", rfc, api: efosApi, error: lista69B.error }, "Lista 69-B check failed — provider error"); skippedChecks.push("lista69B"); }
  if (art69.skipped)   { log.error({ stage: "employer-a", rfc, api: art69Api, error: art69.error }, "Art. 69 check failed — provider error"); skippedChecks.push("art69"); }
  if (denue.skipped)   { log.error({ stage: "employer-a", rfc, api: "denue", error: denue.error }, "DENUE check failed — provider error"); skippedChecks.push("denue"); }
  if (repse.skipped)   { log.error({ stage: "employer-a", rfc, api: "repse", error: repse.error }, "REPSE check failed — provider error"); skippedChecks.push("repse"); }

  // Cost tracking — paid APIs only. Local SAT provider is free; leave cost
  // reporting silent in that branch so accounting stays accurate.
  if (EMPLOYER_SAT_PROVIDER === "sw") {
    if (!lista69B.skipped) costItems.push({ api: "sw-69b", mxn: 0.5 });
    if (!art69.skipped)   costItems.push({ api: "sw-art69", mxn: 0.5 });
  }

  const signals = { lista69B, art69, denue, repse };

  // ── Hard reject: Lista 69-B DEFINITIVO ────────────────────────────────
  if (lista69B.hardReject) {
    log.warn({ stage: "employer-a", rfc }, "EFOS DEFINITIVO — hard reject");
    return cacheAndReturn(cacheKey, {
      pass: false,
      hardReject: true,
      reason: "lista_69b_definitivo",
      signals,
      cost: costItems,
      durationMs: Date.now() - startTime,
    });
  }

  // ── Art. 69 fiscal debt = reject ──────────────────────────────────────
  if (!art69.pass && !art69.skipped) {
    log.warn({ stage: "employer-a", rfc }, "Art. 69 fiscal debt found");
    return cacheAndReturn(cacheKey, {
      pass: false,
      hardReject: false,
      reason: "art69_fiscal_debt",
      signals,
      cost: costItems,
      durationMs: Date.now() - startTime,
    });
  }

  // ── DENUE not found = reject ──────────────────────────────────────────
  if (!denue.pass && !denue.skipped) {
    log.warn({ stage: "employer-a", rfc }, "DENUE — no matching business found");
    return cacheAndReturn(cacheKey, {
      pass: false,
      hardReject: false,
      reason: "denue_not_found",
      signals,
      cost: costItems,
      durationMs: Date.now() - startTime,
    });
  }

  // ── REPSE not registered = reject ─────────────────────────────────────
  if (!repse.pass && !repse.skipped) {
    log.warn({ stage: "employer-a", rfc }, "REPSE — not registered or expired");
    return cacheAndReturn(cacheKey, {
      pass: false,
      hardReject: false,
      reason: "repse_not_registered",
      signals,
      cost: costItems,
      durationMs: Date.now() - startTime,
    });
  }

  // ── Provider errors → escalate to manual review (never pass silently) ─
  if (skippedChecks.length > 0) {
    log.warn({ stage: "employer-a", rfc, skippedChecks }, "Provider errors — escalating to manual review");
    return cacheAndReturn(cacheKey, {
      pass: false,
      hardReject: false,
      escalateToStage: 5,
      reason: "provider_errors_escalate",
      skippedChecks,
      signals,
      cost: costItems,
      durationMs: Date.now() - startTime,
    });
  }

  // ── PRESUNTO = flag, but still passes (Part B will weigh it) ──────────
  // All non-skipped, non-PRESUNTO checks passed if we reach here
  return cacheAndReturn(cacheKey, {
    pass: true,
    hardReject: false,
    reason: null,
    signals,
    cost: costItems,
    durationMs: Date.now() - startTime,
  });
}

async function cacheAndReturn(cacheKey, result) {
  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL).catch(() => {});
  return result;
}

module.exports = { runEmployerScreening };
