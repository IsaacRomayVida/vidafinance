"use strict";
/**
 * sw-client.js
 * SW SAPiens (sw.com.mx) — SAT blacklist & fiscal debt checks.
 *
 * SW uses rotating JWT tokens (expire every 2h).
 * Credentials (SW_USER + SW_PASSWORD) are stored on Railway;
 * tokens are fetched on demand and cached in Redis with 100-min TTL.
 *
 * Endpoints:
 *   - Lista 69-B (EFOS): tax-fraud blacklist
 *   - Art. 69: fiscal debt registry
 *
 * Docs: https://developers.sw.com.mx
 */
const fetch = require("node-fetch");
const redis = require("./redis-client");

const SW_TOKEN_KEY = "sw:token";
const CACHE_TTL    = 86400; // 24 h for lookup results

const BASE = () => process.env.SW_BASE_URL || "https://services.sw.com.mx";

async function getSWToken() {
  const cached = await redis.get(SW_TOKEN_KEY).catch(() => null);
  if (cached) return cached;

  const res = await fetch(`${BASE()}/security/authenticate`, {
    headers: { user: process.env.SW_USER, password: process.env.SW_PASSWORD },
    timeout: 10000,
  });
  const data = await res.json();
  if (!data?.data?.token) throw new Error("SW auth failed: " + JSON.stringify(data));

  const token = data.data.token;
  await redis.set(SW_TOKEN_KEY, token, "EX", 6000); // 100 min — well under 2h expiry
  return token;
}

// ── Lista 69-B (EFOS) — tax-fraud blacklist ──────────────────────────
// situacion: null           → not on list (PASS)
// situacion: "DEFINITIVO"   → hard reject — stop all processing
// situacion: "PRESUNTO"     → flag — continue but require Part B
async function check69B(rfc) {
  const cacheKey = `sw:69b:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const token = await getSWToken();
  const res = await fetch(`${BASE()}/efos/v1/${rfc}`, {
    headers: { Authorization: `bearer ${token}` },
    timeout: 10000,
  });
  const data = await res.json();

  const situacion = data?.data?.situacion || null;
  const result = {
    rfc,
    situacion,
    pass:       situacion === null,
    flag:       situacion === "PRESUNTO",
    hardReject: situacion === "DEFINITIVO",
    raw:        data,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  return result;
}

// ── Art. 69 — fiscal debt registry ───────────────────────────────────
// Any fiscal debt listed → reject
async function checkArt69(rfc) {
  const cacheKey = `sw:art69:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const token = await getSWToken();
  const res = await fetch(`${BASE()}/art69/v1/${rfc}`, {
    headers: { Authorization: `bearer ${token}` },
    timeout: 10000,
  });
  const data = await res.json();

  const deudas = data?.data?.deudas || data?.data?.records || [];
  const result = {
    rfc,
    hasDebt: deudas.length > 0,
    count:   deudas.length,
    pass:    deudas.length === 0,
    raw:     data,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  return result;
}

module.exports = { getSWToken, check69B, checkArt69 };
