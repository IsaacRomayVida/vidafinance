"use strict";
/**
 * Stage 1: Identity Validation
 *
 * Checks:
 *   1. RFC format validation (regex)
 *   2. CURP format validation (regex)
 *   3. Age 18-65 from CURP parse
 *   4. CNBV sector risk flag (informational)
 *
 * Note: individual SAT taxpayer-status check was dropped 2026-04-21. Tier-1
 * Mexican workers commonly have personal RFCs in "suspendido" state (no
 * personal invoicing history), which a direct SAT check would reject. This
 * check was also redundant with MetaMap gov-check performed in Stage 4.
 *
 * ~5% reject rate.
 */
const { checkCNBVSector } = require("../gov-apis");

// RFC: 4 letters + 6 digits (date) + 3 alphanum (homoclave) for persona física
// Persona moral: 3 letters + 6 digits + 3 alphanum
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

// CURP: 4 letters + 6 digits (DOB) + H/M + 2 letters (state) + 3 consonants + 1 digit/letter + 1 digit
const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/;

function parseAgeFromCurp(curp) {
  if (!curp || curp.length < 10) return null;
  const yy = parseInt(curp.substring(4, 6), 10);
  const mm = parseInt(curp.substring(6, 8), 10) - 1;
  const dd = parseInt(curp.substring(8, 10), 10);
  // CURPs with yy < 40 are 2000s, else 1900s
  const year = yy < 40 ? 2000 + yy : 1900 + yy;
  const dob = new Date(year, mm, dd);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (now.getMonth() < dob.getMonth() ||
      (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

async function runIdentityValidation(applicant, priorResults, { logger, db } = {}) {
  const log = logger || console;
  const costItems = [];

  log.info({ stage: "stage1", rfc: applicant.rfc }, "Starting identity validation");

  const data = {};

  // 1. RFC format validation
  const rfcValid = RFC_REGEX.test((applicant.rfc || "").toUpperCase());
  data.rfcValid = rfcValid;
  if (!rfcValid) {
    return {
      pass: false,
      escalateToStage: null,
      reason: "INVALID_RFC_FORMAT",
      data,
      cost: costItems,
    };
  }

  // 2. CURP format validation
  const curpValid = CURP_REGEX.test((applicant.curp || "").toUpperCase());
  data.curpValid = curpValid;
  if (!curpValid) {
    return {
      pass: false,
      escalateToStage: null,
      reason: "INVALID_CURP_FORMAT",
      data,
      cost: costItems,
    };
  }

  // 3. Age from CURP: must be 18-65
  const age = parseAgeFromCurp(applicant.curp.toUpperCase());
  data.age = age;
  if (age !== null && (age < 18 || age > 65)) {
    return {
      pass: false,
      escalateToStage: null,
      reason: age < 18 ? "UNDERAGE" : "OVERAGE",
      data,
      cost: costItems,
    };
  }

  // NOTE: the individual SAT taxpayer-status check was intentionally removed
  // (MetaMap's government check in Stage 4 covers individual SAT; employer SAT
  // status is inferred from EFOS + Art. 69 in Employer Stage A). The former
  // `satResult` escalation block lived here and referenced an undefined variable.

  // 5. CNBV sector risk (informational — uses Firestore)
  let cnbvResult = { pass: true, skipped: true };
  if (db && applicant.sectorCode) {
    try {
      cnbvResult = await checkCNBVSector(db, applicant.sectorCode);
    } catch (err) {
      cnbvResult = { pass: false, skipped: true, error: err.message };
    }
  }
  data.cnbv = cnbvResult;

  return {
    pass: true,
    escalateToStage: null,
    reason: null,
    flags: { cnbvHighRisk: cnbvResult.flag || false },
    data,
    cost: costItems,
  };
}

module.exports = { runIdentityValidation, parseAgeFromCurp, RFC_REGEX, CURP_REGEX };
