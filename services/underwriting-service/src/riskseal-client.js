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

  const baseUrl = process.env.RISKSEAL_BASE_URL || process.env.RISKSEAL_API_URL;
  if (!baseUrl) throw new Error('RiskSeal base URL not configured');
  const res = await fetch(`${baseUrl}/credit-scoring/v2`, {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.RISKSEAL_API_KEY,
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
  const creditScore = data.credit_score || 0;
  const trustScore = data.trust_score || 0;
  const profile = data.profile || {};
  const metrics = data.metrics || {};
  return {
    score:       creditScore,
    trust_score: trustScore,
    risk_level:  creditScore >= 600 ? "low" : creditScore >= 400 ? "medium" : creditScore >= 200 ? "high" : "very_high",
    pass:        creditScore >= 200,
    signals: {
      email_age_days: profile.attributes?.email_age || 0,
      phone_email_connected: profile.attributes?.phone_email_connected,
      suspicious: profile.attributes?.suspicious,
      total_accounts: profile.total_accounts || 0,
      digital_presence: metrics.digital_presence || 0,
    },
  };
}

module.exports = { checkDigitalFootprint };
