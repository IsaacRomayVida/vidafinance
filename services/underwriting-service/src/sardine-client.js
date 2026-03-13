"use strict";
/**
 * sardine-client.js
 * Sardine.ai behavioral biometrics — Stage 4 fraud detection.
 *
 * Sardine requires a sales call (https://www.sardine.ai/contact-us)
 * or sandbox access (https://dashboard.sardine.ai).
 *
 * Flow:
 *   1. Frontend loads Sardine JS snippet on KYC pages (Stage 4)
 *   2. Snippet tracks keystrokes, mouse, scroll, touch → returns sessionKey
 *   3. Backend queries POST /v1/devices with sessionKey → risk signals
 *
 * Until credentials arrive, SARDINE_MOCK=true returns deterministic results.
 *
 * Docs: https://docs.sardine.ai
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.SARDINE_MOCK === "true";

const ENV_MAP = {
  sandbox:    "https://api.sandbox.sardine.ai",
  production: "https://api.sardine.ai",
};

function getBaseUrl() {
  return ENV_MAP[process.env.SARDINE_ENV] || ENV_MAP.sandbox;
}

function mockResult(sessionKey = "") {
  const seed = (sessionKey || "").slice(-3);
  if (seed === "BAD") return {
    risk_level: "very_high", score: 95,
    signals: { bot_detected: true, emulator: true, velocity_flag: true },
    pass: false, mocked: true,
  };
  if (seed === "MED") return {
    risk_level: "high", score: 72,
    signals: { bot_detected: false, emulator: false, velocity_flag: true },
    pass: false, mocked: true,
  };
  return {
    risk_level: "low", score: 15,
    signals: { bot_detected: false, emulator: false, velocity_flag: false },
    pass: true, mocked: true,
  };
}

/**
 * Query Sardine for behavioral risk signals from a frontend session.
 * @param {string} sessionKey — from Sardine frontend snippet
 * @param {string} customerId — internal user/employee ID
 */
async function checkBehavioralRisk(sessionKey, customerId) {
  if (MOCK()) return mockResult(sessionKey);

  const credentials = Buffer.from(
    `${process.env.SARDINE_CLIENT_ID}:${process.env.SARDINE_SECRET_KEY}`
  ).toString("base64");

  const res = await fetch(`${getBaseUrl()}/v1/devices`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionKey, customerId }),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sardine ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const riskLevel = data.level || data.risk_level || "unknown";

  return {
    risk_level: riskLevel,
    score:      data.score || null,
    signals:    data.signals || {},
    pass:       riskLevel !== "high" && riskLevel !== "very_high",
  };
}

module.exports = { checkBehavioralRisk };
