"use strict";
/**
 * riskseal-smoke.js
 * GET /riskseal/smoke — VID3-713 live-verification endpoint.
 *
 * Isolates the RiskSeal call from the full underwriting pipeline so operators
 * can confirm the adapter is wired correctly (credentials + base URL +
 * RISKSEAL_MOCK=false) without triggering employer-screening / KYC / bureau
 * calls. Internal-secret guarded — not reachable from the public origin.
 *
 * Input query params (all optional, defaults are synthetic but well-formed):
 *   email — test email address
 *   phone — E.164 phone, Mexico default
 *   ip    — IPv4
 *   rfc   — RFC used only for mock-mode seeding
 *
 * Response 200:
 *   {
 *     envMock,         // process.env.RISKSEAL_MOCK === "true"
 *     baseUrl,         // process.env.RISKSEAL_BASE_URL (never the api key)
 *     apiKeyPresent,   // true if RISKSEAL_API_KEY is non-empty
 *     durationMs,
 *     result,          // whatever checkDigitalFootprint returned
 *   }
 * Response 502 on RiskSeal error:
 *   { error, message, envMock, baseUrl, apiKeyPresent, durationMs }
 */
const { checkDigitalFootprint } = require("./riskseal-client");

const DEFAULTS = {
  email: "vida-riskseal-smoke@example.com",
  phone: "+5215555000001",
  ip: "189.203.10.42",
  rfc: "SMOK900101ABC",
};

async function riskSealSmokeHandler(req, res) {
  const email = (req.query?.email || DEFAULTS.email).toString().slice(0, 320);
  const phone = (req.query?.phone || DEFAULTS.phone).toString().slice(0, 32);
  const ip = (req.query?.ip || DEFAULTS.ip).toString().slice(0, 64);
  const rfc = (req.query?.rfc || DEFAULTS.rfc).toString().slice(0, 32);

  const envMock = process.env.RISKSEAL_MOCK === "true";
  const baseUrl = process.env.RISKSEAL_BASE_URL || process.env.RISKSEAL_API_URL || null;
  const apiKeyPresent = Boolean(process.env.RISKSEAL_API_KEY);

  const start = Date.now();
  try {
    const result = await checkDigitalFootprint({ email, phone, ip, rfc });
    return res.status(200).json({
      envMock,
      baseUrl,
      apiKeyPresent,
      durationMs: Date.now() - start,
      result,
    });
  } catch (err) {
    return res.status(502).json({
      error: "riskseal_call_failed",
      message: err?.message || String(err),
      envMock,
      baseUrl,
      apiKeyPresent,
      durationMs: Date.now() - start,
    });
  }
}

module.exports = { riskSealSmokeHandler, DEFAULTS };
