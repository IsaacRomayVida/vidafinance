const fetch = require("node-fetch");
require("dotenv").config({ path: "functions/.env" });

const SERVICES = {
  "payment-server":        process.env.PAYMENT_SERVER_URL,
  "softcredito-adapter":   process.env.SOFTCREDITO_ADAPTER_URL,
  "notification-service":  process.env.NOTIFICATION_SERVICE_URL,
  "pdf-generator":         process.env.PDF_GENERATOR_URL,
  "ml-service":            process.env.ML_SERVICE_URL,
};

const results = [];
const ok  = (n,d) => { results.push({s:"OK ",n,d}); };
const warn= (n,d) => { results.push({s:"WRN",n,d}); };
const fail= (n,d) => { results.push({s:"ERR",n,d}); };

async function run() {
  console.log("\nVIDA Finance — Production Verification\n" + "=".repeat(50));

  for (const [name, url] of Object.entries(SERVICES)) {
    if (!url) { fail(name, "URL not set in functions/.env"); continue; }
    try {
      const r = await fetch(url + "/health", { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (d.status === "ok" && d.redis !== false) ok(name, "healthy");
      else if (d.status === "ok") warn(name, "running but Redis=false");
      else fail(name, "status=" + d.status);
    } catch(e) { fail(name, e.message); }
  }

  const required = ["REDIS_URL","CONEKTA_API_KEY","INTERNAL_SECRET"];
  for (const v of required) {
    if (process.env[v]) ok("env:"+v, process.env[v].slice(0,8)+"...");
    else fail("env:"+v, "NOT SET");
  }

  const ck = process.env.CONEKTA_API_KEY || "";
  if (ck.startsWith("key_live_")) ok("conekta-key", "LIVE key");
  else if (ck.startsWith("key_")) ok("conekta-key", "SANDBOX key — switch to key_live_ before accepting real payments");
  else fail("conekta-key", "key not recognized");

  const sec = process.env.INTERNAL_SECRET || "";
  if (sec.length >= 32) ok("internal-secret", "length OK (" + sec.length + " chars)");
  else fail("internal-secret", "too short — run: openssl rand -hex 32");

  console.log("");
  for (const r of results)
    console.log("[" + r.s + "]  " + r.n.padEnd(28) + r.d);

  const errs = results.filter(r => r.s === "ERR").length;
  const warns= results.filter(r => r.s === "WRN").length;
  console.log("\n" + "=".repeat(50));
  if (errs === 0 && warns === 0)
    console.log("READY: All checks passed. System ready for launch.");
  else if (errs > 0)
    console.log("BLOCKED: " + errs + " error(s) must be fixed before launch.");
  else
    console.log("REVIEW: " + warns + " warning(s) — review before accepting live payments.");
  process.exit(errs > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
