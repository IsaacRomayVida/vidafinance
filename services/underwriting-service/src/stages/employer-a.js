"use strict";
/**
 * Employer Part A: Screening
 *
 * All checks run in parallel. Cost: ~$1-3 MXN. Time: ~30s. ~80% pass.
 *
 * Checks:
 *   1. SAT active status (Verifik)
 *   2. Lista 69-B EFOS blacklist (SW)
 *   3. Art. 69 fiscal debt (SW)
 *   4. DENUE business registry (gov-apis)
 *   5. REPSE labor compliance (gov-apis)
 */
const { checkSATTaxpayer } = require("../verifik");
const { check69B, checkArt69 } = require("../sw-client");
const { checkDENUE, checkREPSE } = require("../gov-apis");

async function runEmployerScreening(employer, { logger } = {}) {
  const log = logger || console;
  const rfc = employer.rfc;
  const costItems = [];

  log.info({ stage: "employer-a", rfc }, "Starting employer screening");

  const [satResult, efosResult, art69Result, denueResult, repseResult] =
    await Promise.allSettled([
      checkSATTaxpayer(rfc),
      check69B(rfc),
      checkArt69(rfc),
      checkDENUE(employer.companyName, employer.stateCode),
      checkREPSE(rfc),
    ]);

  const sat   = satResult.status   === "fulfilled" ? satResult.value   : { pass: true, skipped: true, error: satResult.reason?.message };
  const efos  = efosResult.status  === "fulfilled" ? efosResult.value  : { pass: true, skipped: true, error: efosResult.reason?.message };
  const art69 = art69Result.status === "fulfilled" ? art69Result.value : { pass: true, skipped: true, error: art69Result.reason?.message };
  const denue = denueResult.status === "fulfilled" ? denueResult.value : { pass: true, skipped: true, error: denueResult.reason?.message };
  const repse = repseResult.status === "fulfilled" ? repseResult.value : { pass: true, skipped: true, error: repseResult.reason?.message };

  // SAT + SW are paid calls
  if (!sat.skipped)   costItems.push({ api: "verifik-sat", mxn: 1.5 });
  if (!efos.skipped)  costItems.push({ api: "sw-69b", mxn: 0.5 });
  if (!art69.skipped) costItems.push({ api: "sw-art69", mxn: 0.5 });

  // Lista 69-B DEFINITIVO = permanent hard reject — stop immediately
  if (efos.hardReject) {
    log.warn({ stage: "employer-a", rfc }, "EFOS DEFINITIVO — hard reject");
    return {
      pass: false,
      escalateToStage: null,
      reason: "EFOS_DEFINITIVO",
      data: { sat, efos, art69, denue, repse },
      cost: costItems,
    };
  }

  // SAT not active = reject
  if (!sat.pass && !sat.skipped) {
    log.warn({ stage: "employer-a", rfc }, "SAT not active");
    return {
      pass: false,
      escalateToStage: null,
      reason: "SAT_INACTIVE",
      data: { sat, efos, art69, denue, repse },
      cost: costItems,
    };
  }

  // Art. 69 fiscal debt = reject
  if (!art69.pass && !art69.skipped) {
    log.warn({ stage: "employer-a", rfc }, "Art. 69 fiscal debt found");
    return {
      pass: false,
      escalateToStage: null,
      reason: "FISCAL_DEBT",
      data: { sat, efos, art69, denue, repse },
      cost: costItems,
    };
  }

  // EFOS PRESUNTO = flag, continue but escalate to Part B
  const efosFlag = efos.flag || false;

  // DENUE not found or REPSE invalid = informational flags (not hard rejects)
  const denueFlag = !denue.pass && !denue.skipped;
  const repseFlag = !repse.pass && !repse.skipped;

  const allPass = sat.pass && efos.pass && art69.pass;

  return {
    pass: allPass,
    escalateToStage: allPass ? null : "employer-b",
    reason: allPass ? null : "EMPLOYER_FLAGS",
    flags: { efosFlag, denueFlag, repseFlag },
    data: { sat, efos, art69, denue, repse },
    cost: costItems,
  };
}

module.exports = { runEmployerScreening };
