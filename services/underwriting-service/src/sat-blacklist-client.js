"use strict";
/**
 * sat-blacklist-client.js — VID3-714
 *
 * Drop-in replacement for [sw-client.js](./sw-client.js) that reads the two
 * SAT blacklists self-hosted in GCS by the `satBlacklistRefresh` Cloud
 * Function instead of hitting SW SAPiens. Exposes the same three entry
 * points (`check69B`, `checkArt69`, `getSWToken`) with identical return
 * shapes so [employer-a.js](./stages/employer-a.js) can switch providers
 * via the `EMPLOYER_SAT_PROVIDER` feature flag with no downstream changes.
 *
 * Load strategy:
 *   - On first check69B/checkArt69 call we download sat/efos.json and
 *     sat/art69.json from the default GCS bucket and parse into
 *     in-memory `Map<rfc, entry>` tables.
 *   - Subsequent calls hit the maps directly (~ns lookup).
 *   - After REFRESH_INTERVAL_MS (4h) we trigger a background reload so
 *     the CF's monthly refresh is picked up without a pod restart.
 *   - Concurrent callers share a single in-flight download via a shared
 *     `loadPromise` — we never issue more than one GCS fetch at a time.
 *
 * Failure semantics:
 *   - If GCS is unreachable or the expected blob is missing we THROW.
 *     employer-a.js's Promise.allSettled already converts that into a
 *     `{ pass: false, skipped: true, error }` signal which escalates
 *     the application to Stage 5 (manual review) — the existing safe
 *     default. We never silently pass when SAT data is missing.
 *   - "Missing" includes a blob that downloads and parses cleanly but
 *     carries no usable rows. An empty `Map` is not "nobody is on the
 *     list", it is "we do not know who is on the list": every RFC lookup
 *     misses, `situacion` is null, `hasDebt` is false, and every employer
 *     in the country clears both screens with pass:true. `parseRows`
 *     therefore rejects a blob whose `rows` is absent, not an object, an
 *     array, or empty, and it does so BEFORE the loaded tables are
 *     swapped in — a bad refresh leaves the last-good list in place
 *     rather than blanking it.
 *
 * Cache scoping:
 *   - The per-RFC Redis entries are keyed by the `generatedAt` of the
 *     dataset that produced them. A verdict is only meaningful relative
 *     to a specific SAT publication, so an answer computed against one
 *     generation is never replayed against another. Without this, a pass
 *     computed during a bad-data window outlives the window by the full
 *     24h TTL, long after the underlying blob is repaired.
 *   - Consequently `ensureLoaded()` runs before the cache read: we cannot
 *     name the generation we are answering for until the tables are
 *     loaded. In practice this costs nothing — any pod serving real
 *     traffic misses the cache on its first unseen RFC and loads anyway.
 */

const admin = require("firebase-admin");
const redis = require("./redis-client");

const EFOS_PATH = "sat/efos.json";
const ART69_PATH = "sat/art69.json";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_TTL_SECONDS = 86400; // 24h for per-RFC Redis cache (cross-pod)

const state = {
  efos: null,         // Map<rfc, { rfc, nombre, situacion }>
  art69: null,        // Map<rfc, { rfc, nombre, tipo_adeudo, monto }>
  loadedAt: 0,
  generatedAt: { efos: null, art69: null },
  loadPromise: null,
};

function getBucketName() {
  const name =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.GCS_BUCKET ||
    null;
  if (!name) {
    throw new Error(
      "FIREBASE_STORAGE_BUCKET not configured — sat-blacklist-client needs the default GCS bucket name"
    );
  }
  return name;
}

async function downloadJson(path) {
  const bucket = admin.storage().bucket(getBucketName());
  const file = bucket.file(path);
  const [buf] = await file.download();
  return JSON.parse(buf.toString("utf-8"));
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Turn a downloaded blob into the lookup Map, or throw. Throwing is the whole
// point: every rejection here reaches employer-a.js as a skipped check and
// escalates to manual review, which is the correct answer when we cannot say
// whether an RFC is blacklisted. Silently returning an empty Map would answer
// "clean" for every employer instead.
function parseRows(blob, path) {
  if (!isPlainObject(blob) || !isPlainObject(blob.rows)) {
    throw new Error(
      `${path} is not a { generatedAt, rows: { [rfc]: entry } } blob — refusing to screen against it`
    );
  }
  const m = new Map(Object.entries(blob.rows));
  if (m.size === 0) {
    throw new Error(
      `${path} loaded 0 rows — refusing to screen employers against an empty SAT list`
    );
  }
  return m;
}

async function doLoad() {
  const [efosBlob, art69Blob] = await Promise.all([
    downloadJson(EFOS_PATH),
    downloadJson(ART69_PATH),
  ]);
  // Validate both blobs before mutating `state`, so a bad refresh cannot
  // replace a good in-memory list with an empty one.
  const efos = parseRows(efosBlob, EFOS_PATH);
  const art69 = parseRows(art69Blob, ART69_PATH);

  state.efos = efos;
  state.art69 = art69;
  state.loadedAt = Date.now();
  state.generatedAt = {
    efos: efosBlob.generatedAt || null,
    art69: art69Blob.generatedAt || null,
  };
}

function needsLoad() {
  if (!state.efos || !state.art69) return true;
  return Date.now() - state.loadedAt > REFRESH_INTERVAL_MS;
}

async function ensureLoaded() {
  if (!needsLoad()) return;
  if (state.loadPromise) return state.loadPromise;
  state.loadPromise = (async () => {
    try {
      await doLoad();
    } finally {
      state.loadPromise = null;
    }
  })();
  return state.loadPromise;
}

// A verdict is only valid for the SAT publication it was computed from, so the
// generation is part of the key. `unknown` covers a legacy blob written before
// the refresh function stamped `generatedAt`.
function cacheKeyFor(list, rfc) {
  const generation =
    (list === "69b" ? state.generatedAt.efos : state.generatedAt.art69) ||
    "unknown";
  return `sat:${list}:${generation}:${rfc}`;
}

// ── Lista 69-B (EFOS) ────────────────────────────────────────────────────
// Return shape matches sw-client.check69B exactly.
async function check69B(rfc) {
  await ensureLoaded();

  const cacheKey = cacheKeyFor("69b", rfc);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const entry = state.efos.get(rfc) || null;
  const situacion = entry?.situacion || null;

  const result = {
    rfc,
    situacion,
    pass: situacion === null,
    flag: situacion === "PRESUNTO",
    hardReject: situacion === "DEFINITIVO",
    raw: {
      source: "sat-local",
      generatedAt: state.generatedAt.efos,
      entry,
    },
  };

  await redis
    .set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS)
    .catch(() => {});
  return result;
}

// ── Art. 69 — fiscal debt registry ───────────────────────────────────────
// Return shape matches sw-client.checkArt69 exactly.
async function checkArt69(rfc) {
  await ensureLoaded();

  const cacheKey = cacheKeyFor("art69", rfc);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const entry = state.art69.get(rfc) || null;
  const hasDebt = !!entry;

  const result = {
    rfc,
    hasDebt,
    count: hasDebt ? 1 : 0,
    pass: !hasDebt,
    raw: {
      source: "sat-local",
      generatedAt: state.generatedAt.art69,
      entry,
    },
  };

  await redis
    .set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS)
    .catch(() => {});
  return result;
}

// Kept only for API parity with sw-client. The local client has no token
// concept, so this is a no-op; any caller that actually needs a SW token
// must import sw-client directly (which won't happen if the flag is set
// correctly — see employer-a.js).
async function getSWToken() {
  throw new Error(
    "sat-blacklist-client.getSWToken — this provider has no token concept; use sw-client instead"
  );
}

// Exposed for tests only — resets the in-memory cache between cases.
function __resetForTests() {
  state.efos = null;
  state.art69 = null;
  state.loadedAt = 0;
  state.generatedAt = { efos: null, art69: null };
  state.loadPromise = null;
}

module.exports = {
  getSWToken,
  check69B,
  checkArt69,
  __resetForTests,
};
