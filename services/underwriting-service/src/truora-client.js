"use strict";
/**
 * truora-client.js
 * Truora — AML watchlists, criminal records, PEP, sanctions (Stage 5).
 *
 * Truora checks are async: startCheck returns a check_id, then poll
 * until status=completed (real checks take 30–120s, scraping 32 state DBs).
 * Mock simulates this async pattern so upstream code doesn't need refactoring.
 *
 * Sign up: https://dashboard.truora.com/sign-up (1–3 days approval)
 * Set TRUORA_MOCK=true until API key arrives.
 *
 * IMPORTANT: Log ALL results to Firestore (including clean ones) —
 * clean Stage 5 results are ML training signals.
 *
 * Docs: https://docs.truora.com
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.TRUORA_MOCK === "true";
const BASE = () => process.env.TRUORA_BASE_URL || "https://api.checks.truora.com/v1";

function mockResult(rfc = "") {
  const seed = rfc.slice(-3);
  if (seed === "XXX") return {
    check_id: `mock-${rfc}`, status: "completed",
    criminal_record: false, pep: false,
    aml_watchlists: [{ list: "OFAC", match_type: "CONFIRMED" }],
    hard_reject: true, mocked: true,
  };
  if (seed === "YYY") return {
    check_id: `mock-${rfc}`, status: "completed",
    criminal_record: false, pep: false,
    aml_watchlists: [{ list: "CNBV_LISTA_NEGRA", match_type: "FUZZY" }],
    hard_reject: false, requires_human_review: true, mocked: true,
  };
  return {
    check_id: `mock-${rfc}`, status: "completed",
    criminal_record: false, pep: false, aml_watchlists: [],
    lists_checked: ["OFAC", "UN", "EU", "CNBV_LISTA_NEGRA"],
    hard_reject: false, mocked: true,
  };
}

/**
 * Start an async background check.
 * Real checks: criminal_mx + pep_global + aml_global + sanctions_mx.
 */
async function startCheck(employeeData) {
  if (MOCK()) return { check_id: `mock-${employeeData.rfc}-${Date.now()}`, status: "pending" };

  const res = await fetch(`${BASE()}/checks`, {
    method: "POST",
    headers: { "Truora-API-Key": process.env.TRUORA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      country: "MX", type: "person",
      national_id: employeeData.curp, national_id_type: "CURP",
      first_name: employeeData.firstName, last_name: employeeData.lastName,
      check_type: ["criminal_mx", "pep_global", "aml_global", "sanctions_mx"],
    }),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Truora startCheck ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Poll until check completes. Real checks take 30–120s.
 * @param {string} checkId
 * @param {string} rfc — for mock seeding
 * @param {number} maxWaitMs — default 10 minutes
 */
async function pollCheck(checkId, rfc, maxWaitMs = 600000) {
  if (MOCK()) return mockResult(rfc);

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BASE()}/checks/${checkId}`, {
      headers: { "Truora-API-Key": process.env.TRUORA_API_KEY },
      timeout: 10000,
    });
    const data = await res.json();
    if (data.status === "completed") return data;
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error(`Truora check ${checkId} timed out after ${maxWaitMs}ms`);
}

/**
 * Parse raw Truora result into a decision object.
 * confirmed AML or criminal record → hard reject
 * fuzzy AML match or PEP → human review required
 */
function parseResult(result) {
  const confirmedAML = (result.aml_watchlists || []).some(h => h.match_type === "CONFIRMED");
  const fuzzyAML     = (result.aml_watchlists || []).some(h => h.match_type === "FUZZY");
  return {
    hard_reject:           confirmedAML || !!result.criminal_record,
    requires_human_review: fuzzyAML || !!result.pep,
    criminalRecord:        !!result.criminal_record,
    isPEP:                 !!result.pep,
    amlFlags:              result.aml_watchlists || [],
    pass:                  !confirmedAML && !result.criminal_record,
    raw:                   result,
  };
}

module.exports = { startCheck, pollCheck, parseResult };
