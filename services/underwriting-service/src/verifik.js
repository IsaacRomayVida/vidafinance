"use strict";
/**
 * verifik.js
 * Paid identity-verification API (Verifik.co) used across underwriting stages.
 * Endpoints: SAT taxpayer status, RFC validation, RPP property registry.
 * Fallback provider: Signzy (same interface, swap VERIFIK_BASE_URL + key).
 *
 * Pricing: per-call (see https://docs.verifik.co). All results cached
 * in Redis to avoid duplicate charges for the same lookup.
 */
const fetch = require("node-fetch");
const redis = require("./redis-client");

const CACHE_TTL = 86400; // 24 h

const BASE = () => process.env.VERIFIK_BASE_URL || "https://api.verifik.co";
const AUTH = () => {
  const key = process.env.VERIFIK_API_KEY || process.env.VERIFY_API_KEY;
  if (!key) throw new Error("Verifik API key not configured: set VERIFIK_API_KEY env var");
  return { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
};

async function cachedPost(cacheKey, path, body) {
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: AUTH(),
    body: JSON.stringify(body),
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Verifik ${path} ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  await redis.set(cacheKey, JSON.stringify(data), "EX", CACHE_TTL);
  return data;
}

// ── 1. SAT Taxpayer Status (Employer Part A + Employee S1) ───────────
// statusSat: "ACTIVO" = pass | "CANCELADO" / "NO REGISTRADO" = hard reject
async function checkSATTaxpayer(rfc) {
  const cacheKey = `verifik:sat:${rfc}`;
  const data = await cachedPost(cacheKey, "/v2/mx/sat/taxpayers", { rfc });

  return {
    rfc,
    statusSat:      data.statusSat || data.status || null,
    nombre:         data.nombre || null,
    regimen:        data.regimen || [],
    fechaInscripcion: data.fechaInscripcion || null,
    pass:           (data.statusSat || data.status) === "ACTIVO",
    raw:            data,
  };
}

// ── 2. RFC Format + Age Validation (Employer Part A) ─────────────────
// Validates RFC structure and extracts incorporation date proxy
async function validateRFC(rfc) {
  const cacheKey = `verifik:rfc:${rfc}`;
  const data = await cachedPost(cacheKey, "/v2/mx/rfc/validate", { rfc });

  return {
    rfc,
    valid:     !!data.valid,
    type:      data.type || null,       // "persona_fisica" | "persona_moral"
    birthDate: data.birthDate || null,   // extracted from CURP portion
    pass:      !!data.valid,
    raw:       data,
  };
}

// ── 3. RPP Property Registry (Employer Part B) ──────────────────────
// State-level property registry — checks real estate ownership + liens
async function checkRPP(rfc, state) {
  const cacheKey = `verifik:rpp:${rfc}:${state}`;
  const data = await cachedPost(cacheKey, "/v2/mx/rpp/search", { rfc, state });

  const records = data.records || data.results || [];
  return {
    rfc,
    state,
    found:      records.length > 0,
    count:      records.length,
    hasLiens:   records.some(r => r.gravamen || r.lien),
    records:    records.slice(0, 5),
    pass:       records.length > 0,
    raw:        data,
  };
}

module.exports = {
  checkSATTaxpayer,
  validateRFC,
  checkRPP,
};
