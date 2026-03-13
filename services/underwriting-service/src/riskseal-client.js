"use strict";
/**
 * riskseal-client.js
 * RiskSeal digital footprint scoring — email/phone/IP reputation.
 *
 * RiskSeal is contract-only (no self-service sandbox).
 * Contact: hello@riskseal.io — request free PoC (3–5 days).
 *
 * Until the contract arrives, RISKSEAL_MOCK=true returns deterministic
 * mock results seeded on the last 3 chars of the RFC, so upstream
 * integration and decision-tree logic can be built and tested now.
 *
 * Cost gate (per decision tree):
 *   < 200 apps/month → call only on Stage 4+
 *   >= 200 apps/month → call on all applicants
 *
 * Docs: https://docs.riskseal.io
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.RISKSEAL_MOCK === "true";

function mockResult(rfc = "") {
  const seed = rfc.slice(-3);
  if (seed === "XXX") return {
    score: 12, risk_level: "very_high", pass: false,
    signals: { email_age_days: 3, phone_whatsapp: false, ip_proxy: true },
    mocked: true,
  };
  if (seed === "YYY") return {
    score: 38, risk_level: "high", pass: false,
    signals: { email_age_days: 90, phone_whatsapp: true, mercadolibre_account: false },
    mocked: true,
  };
  return {
    score: 72, risk_level: "medium", pass: true,
    signals: {
      email_age_days: 847, email_platforms_found: 4,
      phone_whatsapp: true, phone_age_days: 612,
      ip_proxy: false, mercadolibre_account: true,
    },
    mocked: true,
  };
}

async function checkDigitalFootprint({ email, phone, ip, rfc }) {
  if (MOCK()) return mockResult(rfc);

  const res = await fetch(`${process.env.RISKSEAL_BASE_URL}/score`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RISKSEAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, phone, ip }),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RiskSeal ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    score:      data.score,
    risk_level: data.risk_level,
    pass:       data.score >= 30,
    signals:    data.signals,
  };
}

module.exports = { checkDigitalFootprint };
