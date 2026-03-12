"use strict";
/**
 * underwrite.js
 * SoftCrédito underwriting call + CDC/BDC bureau decision logic.
 *
 * SoftCrédito's /v1/underwrite response includes:
 *   cdc  — Círculo de Crédito (score, diasAtraso, carteraVencida, cuentasActivas)
 *   bdc  — Buró de Crédito    (score, diasAtraso, carteraVencida)
 *   pld  — Prevención de Lavado de Dinero (bloqueo_lista_sat, etc.)
 *
 * Docs: provided by SoftCrédito after contract — no public API reference.
 */
const fetch = require("node-fetch");

const BASE = () => process.env.SOFTCREDITO_API_URL || "https://api.softcredito.com";
const AUTH = () => ({
  "Authorization": `Bearer ${process.env.SOFTCREDITO_API_KEY}`,
  "Content-Type": "application/json",
});

/**
 * Call SoftCrédito underwriting endpoint.
 * Returns the full response including cdc, bdc, and pld sections.
 */
async function callUnderwrite({ curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento }) {
  const res = await fetch(`${BASE()}/v1/underwrite`, {
    method: "POST",
    headers: AUTH(),
    body: JSON.stringify({ curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento }),
    timeout: 30000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SoftCrédito ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * Parse bureau fields from SoftCrédito underwriting response.
 * CDC is primary bureau, BDC is fallback. Returns standardized
 * decision object with stage escalation per the decision tree:
 *
 *   carteraVencida = true     → Stage 5 (immediate escalation)
 *   diasAtraso >= 31          → Stage 5
 *   diasAtraso 1–30           → Stage 4 (flag, continue)
 *   score < 400               → Stage 5
 *   score 400–599             → Stage 4
 *   score >= 600 + clean      → Stage 3 (auto-approve gate)
 */
function parseBureauDecision(scResponse) {
  const cdc = scResponse?.cdc || {};
  const bdc = scResponse?.bdc || {};

  const score       = cdc.score || bdc.score || null;
  const diasAtraso  = Math.max(cdc.diasAtraso || 0, bdc.diasAtraso || 0);
  const carteraVenc = !!(cdc.carteraVencida || bdc.carteraVencida);
  const cuentasActivas = cdc.cuentasActivas || 0;

  let stage  = 3;
  let reason = null;

  if (carteraVenc) {
    stage = 5; reason = "active_default";
  } else if (diasAtraso >= 31) {
    stage = 5; reason = "days_late_31_plus";
  } else if (diasAtraso >= 1) {
    stage = 4; reason = "days_late_1_30";
  } else if (score !== null && score < 400) {
    stage = 5; reason = "score_below_400";
  } else if (score !== null && score < 600) {
    stage = 4; reason = "score_400_599";
  }

  return {
    score,
    diasAtraso,
    carteraVencida: carteraVenc,
    cuentasActivas,
    escalateToStage: stage,
    reason,
    pass: stage === 3,
  };
}

/**
 * Parse PLD (anti-money-laundering) flags from SoftCrédito response.
 * bloqueo_lista_sat = true → matches SAT AML blacklist → Stage 5 / reject.
 * Included in the SC response at $0 extra cost.
 */
function parsePLD(scResponse) {
  const pld = scResponse?.pld || {};
  const blocked = !!(pld.bloqueo_lista_sat || pld.bloqueado);

  return {
    bloqueoListaSat: !!pld.bloqueo_lista_sat,
    bloqueado:       !!pld.bloqueado,
    pass:            !blocked,
    hardReject:      blocked,
    reason:          blocked ? "pld_sat_blacklist" : null,
  };
}

module.exports = { callUnderwrite, parseBureauDecision, parsePLD };
