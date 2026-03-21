"use strict";
/**
 * metamap-client.js
 * MetaMap (formerly Mati) — all-in-one identity verification platform.
 *
 * Stage 4 modules: document-verification, liveness, facematch, device-fingerprint
 * Stage 5 modules: aml-screening, criminal-records, pep-check
 *
 * Set METAMAP_MOCK=true until API key arrives.
 * Sign up: https://dashboard.metamap.com
 *
 * Docs: https://docs.metamap.com
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.METAMAP_MOCK === "true";
const BASE = () => process.env.METAMAP_BASE_URL || "https://api.metamap.com/v2";
const KEY  = () => process.env.METAMAP_API_KEY;

const STAGE_4_MODULES = [
  "document-verification",
  "liveness",
  "facematch",
  "device-fingerprint",
];

const STAGE_5_MODULES = [
  "aml-screening",
  "criminal-records",
  "pep-check",
];

function mockVerification(applicant, modules) {
  const seed = (applicant.rfc || "").slice(-3);
  const isStage5 = modules.some(m => STAGE_5_MODULES.includes(m));

  if (isStage5) {
    if (seed === "XXX") return {
      verificationId: `mock-mm-${applicant.rfc}`,
      status: "completed",
      aml: { match: true, list: "OFAC", match_type: "CONFIRMED" },
      criminal: { found: true },
      pep: { match: false },
      pass: false, hard_reject: true, mocked: true,
    };
    if (seed === "YYY") return {
      verificationId: `mock-mm-${applicant.rfc}`,
      status: "completed",
      aml: { match: true, list: "CNBV_LISTA_NEGRA", match_type: "FUZZY" },
      criminal: { found: false },
      pep: { match: true },
      pass: false, requires_human_review: true, mocked: true,
    };
    return {
      verificationId: `mock-mm-${applicant.rfc}`,
      status: "completed",
      aml: { match: false },
      criminal: { found: false },
      pep: { match: false },
      pass: true, hard_reject: false, mocked: true,
    };
  }

  // Stage 4 mock
  if (seed === "XXX") return {
    verificationId: `mock-mm-${applicant.rfc}`,
    status: "completed",
    documentVerification: { pass: false, reason: "EXPIRED_DOCUMENT" },
    liveness: { pass: false },
    facematch: { match: false, confidence: 0.22 },
    deviceFingerprint: { risk_level: "very_high", score: 92 },
    pass: false, mocked: true,
  };
  if (seed === "YYY") return {
    verificationId: `mock-mm-${applicant.rfc}`,
    status: "completed",
    documentVerification: { pass: true },
    liveness: { pass: true },
    facematch: { match: false, confidence: 0.51 },
    deviceFingerprint: { risk_level: "medium", score: 55 },
    pass: false, mocked: true,
  };
  return {
    verificationId: `mock-mm-${applicant.rfc}`,
    status: "completed",
    documentVerification: { pass: true, documentType: "INE" },
    liveness: { pass: true },
    facematch: { match: true, confidence: 0.96 },
    deviceFingerprint: { risk_level: "low", score: 12 },
    pass: true, mocked: true,
  };
}

/**
 * Create a MetaMap verification with the specified modules.
 * @param {object} applicant — { rfc, curp, firstName, lastName, email, phone }
 * @param {string[]} modules — e.g. STAGE_4_MODULES or STAGE_5_MODULES
 * @returns {Promise<object>} verification result
 */
async function createVerification(applicant, modules) {
  if (MOCK()) return mockVerification(applicant, modules);

  const res = await fetch(`${BASE()}/verifications`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metadata: {
        rfc: applicant.rfc,
        curp: applicant.curp,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
      },
      modules,
    }),
    timeout: 30000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaMap ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

module.exports = { createVerification, STAGE_4_MODULES, STAGE_5_MODULES };
