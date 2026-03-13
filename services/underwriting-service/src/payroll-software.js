"use strict";
/**
 * payroll-software.js
 * Payroll software risk tiers for Employer Part B scoring.
 *
 * Higher tier = more reliable payroll data = lower employer risk.
 * CONTPAQi / Aspel NOI detected → invite API integration
 * (bypasses Belvo IMSS cost for verified employers).
 *
 * Firestore field: employers/{id}.payrollSystem
 * Values: "CONTPAQi" | "Aspel NOI" | "SAP" | "Oracle HCM" | "manual" | "other"
 */

const PAYROLL_TIERS = {
  "SAP":        2,
  "Oracle HCM": 2,
  "Workday":    2,

  "CONTPAQi":  1,
  "Aspel NOI": 1,
  "SIIGO":     1,
  "Microsip":  1,

  "manual": 0,
  "other":  0,
};

function getPayrollTier(softwareName) {
  const tier = PAYROLL_TIERS[softwareName] ?? 0;
  const canIntegrate = ["CONTPAQi", "Aspel NOI"].includes(softwareName);
  return { tier, canIntegrate, softwareName };
}

module.exports = { getPayrollTier, PAYROLL_TIERS };
