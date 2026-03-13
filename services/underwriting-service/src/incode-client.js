"use strict";
/**
 * incode-client.js
 * Incode KYC — INE ID scan + selfie liveness + face match.
 *
 * Used in Employee Stage 3 (identity verification).
 * Flow: startSession → frontend captures INE + selfie → getScores.
 *
 * Sandbox: https://dashboard.incode.com/sign-up (may require demo call).
 * Set INCODE_MOCK=true until sandbox/production key arrives.
 *
 * Docs: https://docs.incode.com
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.INCODE_MOCK === "true";
const BASE = () => process.env.INCODE_API_URL || "https://demo-api.incodesmile.com/0";
const KEY  = () => process.env.INCODE_API_KEY;
const FLOW = () => process.env.INCODE_FLOW_ID;

function mockScore(rfc = "") {
  const seed = rfc.slice(-3);
  if (seed === "XXX") return {
    overall: "DECLINED",
    idValidation: { pass: false, reason: "EXPIRED_DOCUMENT" },
    faceRecognition: { match: false },
    liveness: { pass: true },
    mocked: true,
  };
  if (seed === "YYY") return {
    overall: "MANUAL_REVIEW",
    idValidation: { pass: true },
    faceRecognition: { match: false, confidence: 0.51 },
    liveness: { pass: true },
    mocked: true,
  };
  return {
    overall: "APPROVED",
    idValidation: { pass: true, documentType: "INE" },
    faceRecognition: { match: true, confidence: 0.97 },
    liveness: { pass: true },
    mocked: true,
  };
}

/**
 * Start an Incode KYC session for an employee.
 * Returns { token, interviewId } — token is passed to the frontend SDK.
 */
async function startSession(rfc) {
  if (MOCK()) {
    const token = `mock-token-${rfc}-${Date.now()}`;
    return { token, interviewId: `mock-interview-${rfc}` };
  }

  const res = await fetch(`${BASE()}/omni/start`, {
    method: "POST",
    headers: { "X-Incode-Hardware-Id": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({ countryCode: "MX", configurationId: FLOW() }),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Incode startSession ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.token) throw new Error("Incode session failed: " + JSON.stringify(data));
  return { token: data.token, interviewId: data.interviewId };
}

/**
 * Retrieve KYC scores after the employee completes the frontend flow.
 * @param {string} interviewId — from startSession
 * @param {string} token — session token
 * @param {string} rfc — for mock seeding
 * @returns {{ overall, idValidation, faceRecognition, liveness }}
 */
async function getScores(interviewId, token, rfc) {
  if (MOCK()) return mockScore(rfc);

  const res = await fetch(`${BASE()}/omni/scores`, {
    method: "POST",
    headers: { "X-Incode-Hardware-Id": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({ interviewId }),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Incode getScores ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    overall: data.overall === "PASS" ? "APPROVED" : "DECLINED",
    idValidation:    { pass: data.idValidation?.overall === "OK" },
    faceRecognition: { match: data.faceRecognition?.status === "OK",
      confidence: data.faceRecognition?.confidence },
    liveness:        { pass: data.livenessCheck?.status === "OK" },
    raw: data,
  };
}

module.exports = { startSession, getScores };
