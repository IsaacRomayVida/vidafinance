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
// node-fetch v3 is ESM-only. `require("node-fetch")` does not yield the fetch
// function: under Node 22's require(esm) it returns the module namespace, so
// every call here threw "fetch is not a function" before a byte left the
// process, and under jest's CJS runtime it throws "Cannot use import statement
// outside a module" at load, so this file could not even be required by a
// test. ../lib/fetchClient is this service's existing answer to exactly that
// problem -- see its header comment.
const { getFetch } = require("../lib/fetchClient");

const BASE = () => process.env.SOFTCREDITO_API_URL || "https://api.softcredito.com";
const AUTH = () => ({
  "Authorization": `Bearer ${process.env.SOFTCREDITO_API_KEY}`,
  "Content-Type": "application/json",
});

// `timeout:` in the fetch options below was a node-fetch v2 option; v3 ignores
// it silently, leaving this call with no timeout at all. Same default as
// index.js's read-path timeout and lib/scToken.js.
const TIMEOUT_MS = () => Number(process.env.SC_HTTP_TIMEOUT_MS) || 15000;

/**
 * Call SoftCrédito underwriting endpoint.
 * Returns the full response including cdc, bdc, and pld sections.
 */
async function callUnderwrite({ curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento }) {
  const fetch = await getFetch();
  const res = await fetch(`${BASE()}/v1/underwrite`, {
    method: "POST",
    headers: AUTH(),
    body: JSON.stringify({ curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento }),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
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
 *
 * Every rule above is a comparison against a number. Anything that is not a
 * readable number — absent, null, "N/A", NaN — satisfies none of them, so the
 * pre-fix version returned Stage 3 / pass:true for it: no bureau data at all
 * scored identically to a clean file with a good score. `num()` below reads a
 * field as a finite number or as "unread", never as a silent 0, and unread
 * gating data now escalates instead of passing.
 */

// Read a bureau field as a finite number. Returns null for absent, null,
// NaN, "" and anything non-numeric. Numeric strings are honoured because
// upstream payloads quote their numbers inconsistently. NOT `||`-style: a
// real 0 (the worst possible score, and a meaningful diasAtraso) survives.
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// True when the field was present in the payload but could not be read as a
// number — i.e. the bureau told us something about it and we failed to
// understand it. That is not the same as the bureau being silent, and it must
// never collapse to "0" / "clean".
function presentButUnreadable(v) {
  return v !== undefined && v !== null && num(v) === null;
}

function parseBureauDecision(scResponse) {
  const cdc = scResponse?.cdc || {};
  const bdc = scResponse?.bdc || {};

  const score       = num(cdc.score) ?? num(bdc.score);
  const diasAtrasoValues = [num(cdc.diasAtraso), num(bdc.diasAtraso)].filter((n) => n !== null);
  const diasAtraso  = diasAtrasoValues.length ? Math.max(...diasAtrasoValues) : 0;
  const carteraVenc = !!(cdc.carteraVencida || bdc.carteraVencida);
  const cuentasActivas = num(cdc.cuentasActivas) ?? 0;

  const unreadableField =
    presentButUnreadable(cdc.score) || presentButUnreadable(bdc.score) ||
    presentButUnreadable(cdc.diasAtraso) || presentButUnreadable(bdc.diasAtraso);

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
  } else if (unreadableField) {
    // A gating field arrived that we could not parse. Do not guess it clean.
    stage = 4; reason = "bureau_data_unreadable";
  } else if (score === null) {
    // No score from either bureau. The tree above only passes on
    // "score >= 600 + clean", which this is not.
    //
    // OPEN (commercial): Stage 4 here means "flag, a human decides" — the
    // least assumptive non-pass. Whether an absent bureau score should
    // instead be a Stage 5 decline is a credit-policy call and is NOT settled
    // by any existing code or ADR. Deliberately not decided here; the only
    // thing fixed is that it no longer auto-passes.
    stage = 4; reason = "score_unavailable";
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
