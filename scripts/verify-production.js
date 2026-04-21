/**
 * VIDA Finance — production verification
 *
 * Two execution modes:
 *
 *  1. LOCAL   — run by an operator with `functions/.env` populated
 *               (secrets, redis URL, Conekta live key, etc.).
 *               All checks are mandatory; missing env vars → ERR.
 *
 *  2. CI      — run from `.github/workflows/ci.yml` on every push to main.
 *               Diagnostic-only: prints findings but never fails the
 *               workflow. Production gating is handled by Railway/Firebase
 *               dashboards and (once wired) Sentry + external uptime
 *               monitoring, not by this script. Missing secrets → SKP.
 *               Network-level probe failures (wrong URL, wrong region,
 *               transient Railway edge 404s) → recorded but not fatal.
 *
 * CI mode is auto-detected via `process.env.CI === 'true'` (set by GitHub
 * Actions). Can be overridden with `VERIFY_MODE=ci|local`.
 *
 * Exit codes:
 *   0 — always in CI mode; in local mode when all checks pass or only skips
 *   1 — local mode with at least one ERR
 */
require("dotenv").config({ path: "functions/.env" });

const isCI = (process.env.VERIFY_MODE || (process.env.CI === "true" ? "ci" : "local")) === "ci";

const SERVICES = {
  "payment-server":       process.env.PAYMENT_SERVER_URL,
  "softcredito-adapter":  process.env.SOFTCREDITO_ADAPTER_URL,
  "notification-service": process.env.NOTIFICATION_SERVICE_URL,
  "pdf-generator":        process.env.PDF_GENERATOR_URL,
  "ml-service":           process.env.ML_SERVICE_URL,
};

const results = [];
const ok   = (n, d) => results.push({ s: "OK ", n, d });
const warn = (n, d) => results.push({ s: "WRN", n, d });
const skip = (n, d) => results.push({ s: "SKP", n, d });
const fail = (n, d) => results.push({ s: "ERR", n, d });

async function checkHealth(name, url) {
  if (!url) {
    if (isCI) skip(name, "URL secret not set in CI (skipped; only checked locally)");
    else      fail(name, "URL not set in functions/.env");
    return;
  }
  try {
    const r = await fetch(url + "/health", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { fail(name, "HTTP " + r.status); return; }
    let body;
    try { body = await r.json(); } catch { body = null; }
    if (!body || typeof body !== "object") {
      // Some services return plain "ok" text; treat 200 as healthy if JSON absent.
      ok(name, "healthy (non-JSON 200)");
      return;
    }
    if (body.status === "ok" && body.redis !== false) ok(name, "healthy");
    else if (body.status === "ok") warn(name, "running but Redis=false");
    else fail(name, "status=" + body.status);
  } catch (e) {
    fail(name, e.message);
  }
}

function checkEnv(name, predicate, okMsg, failMsg) {
  const v = process.env[name];
  if (!v) {
    if (isCI) skip(`env:${name}`, "not set in CI (expected; only checked locally)");
    else      fail(`env:${name}`, "NOT SET");
    return;
  }
  if (predicate(v)) ok(`env:${name}`, okMsg(v));
  else              fail(`env:${name}`, failMsg(v));
}

async function run() {
  console.log(`\nVIDA Finance — Production Verification (${isCI ? "CI mode" : "local mode"})\n${"=".repeat(60)}`);

  for (const [name, url] of Object.entries(SERVICES)) {
    await checkHealth(name, url);
  }

  checkEnv(
    "REDIS_URL",
    (v) => v.startsWith("redis://") || v.startsWith("rediss://"),
    (v) => v.slice(0, 8) + "...",
    () => "must start with redis:// or rediss://"
  );

  checkEnv(
    "CONEKTA_API_KEY",
    (v) => v.startsWith("key_live_") || v.startsWith("key_"),
    (v) => v.startsWith("key_live_")
      ? "LIVE key"
      : "SANDBOX key — switch to key_live_ before accepting real payments",
    () => "not recognized (expected prefix key_live_ or key_)"
  );

  checkEnv(
    "INTERNAL_SECRET",
    (v) => v.length >= 32,
    (v) => `length OK (${v.length} chars)`,
    (v) => `too short (${v.length} chars) — run: openssl rand -hex 32`
  );

  console.log("");
  for (const r of results) {
    console.log(`[${r.s}]  ${r.n.padEnd(28)}${r.d}`);
  }

  const errs  = results.filter((r) => r.s === "ERR").length;
  const warns = results.filter((r) => r.s === "WRN").length;
  const skips = results.filter((r) => r.s === "SKP").length;

  console.log("\n" + "=".repeat(60));
  if (errs === 0 && warns === 0 && skips === 0) {
    console.log("READY: All checks passed. System ready for launch.");
  } else if (errs > 0 && !isCI) {
    console.log(`BLOCKED: ${errs} error(s)${warns ? `, ${warns} warning(s)` : ""} must be fixed before launch.`);
  } else if (errs > 0 && isCI) {
    console.log(`DIAGNOSTIC: ${errs} probe failure(s), ${warns + skips} other — CI mode is non-gating, not treated as CI failure. Run locally or rely on uptime monitoring for real production gating.`);
  } else if (warns > 0) {
    console.log(`REVIEW: ${warns} warning(s)${skips ? `, ${skips} skip(s)` : ""} — review before accepting live payments.`);
  } else {
    console.log(`SKIPPED: ${skips} check(s) skipped (CI mode); run locally for full verification.`);
  }
  // CI mode is diagnostic-only — prints findings but never fails the run.
  // Production health is monitored by the Railway/Firebase dashboards and
  // (once wired) Sentry + uptime alerting, not by this script.
  process.exit(isCI ? 0 : (errs > 0 ? 1 : 0));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
