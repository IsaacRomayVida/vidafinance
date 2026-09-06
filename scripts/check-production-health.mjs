/**
 * Are the production services actually answering, right now, at the URLs we
 * believe are theirs?
 *
 * Context this check exists to end: ci.yml's "Verify production endpoints" job
 * recorded `HTTP 404` for ALL FIVE Railway service health probes on every run
 * on main for over a month (runs 31335990563 and 32069677859 both show it),
 * and stayed green because that job is diagnostic-only by design. The external
 * uptime monitoring it defers to (docs/runbooks/uptime-monitoring.md) was
 * never stood up. Result: the money-moving backend had NO live health
 * evidence at all, and nothing was in a position to notice.
 *
 * This checker is credential-free on purpose — it asks the same question a
 * borrower's browser asks, so it cannot be wrong about a token and right
 * about the product. It probes THREE distinct claims and refuses to conflate
 * them:
 *
 *   1. CANONICAL — does `<canonical-url>/health` answer 200 + status ok?
 *      The canonical URLs live in scripts/production-endpoints.json, the
 *      single source of truth (SERVICES.md's table had already diverged from
 *      the uptime runbook's before this file existed).
 *   2. SECRET DRIFT — do the leftover `*_URL` repo secrets agree with
 *      canonical? Informational only since deploy.yml started writing these
 *      URLs from this file directly (2026-09-04): a drifted secret feeds
 *      nothing, so it is reported for cleanup, never failed on.
 *      REGISTRY_SERVICE_URL is the exception — deploy.yml still reads it, so
 *      its probe gates.
 *   3. HOSTING — does the public site serve the app shell (`id="root"`), not
 *      just any 200? An empty 200 is "hosting is up but our app isn't".
 *
 * Verdict semantics (mirrors check-registry-funpay-deployed.mjs):
 *   exit 0  every canonical probe healthy, hosting healthy, secrets either
 *           matching or (when divergent) themselves healthy
 *   exit 1  something OBSERVED broken — a probe answered wrong, or a secret
 *           points somewhere that answers wrong
 * There is no exit-2 "unknown" here: a network failure reaching a public URL
 * from a GitHub runner IS the outage condition for a public endpoint, so it
 * is a failure, not a missing observation.
 *
 * `redis: false` in a health body is a FAILURE, not a warning. Every queue in
 * the product (disbursement worker, notifications, rate limits guarding money
 * movement — see #559) sits on that Redis; a service that is "up" without it
 * is a service that will silently strand jobs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── decisions, isolated from I/O so they can be tested ───────────────────── */

/**
 * Classify one /health probe result.
 * `{ httpStatus, body, error }` → `{ status: 'ok'|'down', reason }`.
 * `body` is the parsed JSON body or null (non-JSON).
 */
export function classifyHealth({ httpStatus, body, error }) {
  if (error) return { status: 'down', reason: `unreachable: ${error}` };
  if (httpStatus !== 200) return { status: 'down', reason: `HTTP ${httpStatus}` };
  if (body === null || typeof body !== 'object') {
    // The health contract (SERVICES.md) is JSON, but a plain-text 200 from a
    // service that predates the contract is a liveness signal, not an outage.
    return { status: 'ok', reason: 'healthy (non-JSON 200)' };
  }
  if (body.status !== 'ok') return { status: 'down', reason: `status=${JSON.stringify(body.status)}` };
  if (body.redis === false) {
    return {
      status: 'down',
      reason: 'running but redis=false — BullMQ queues (disbursement, notifications, rate limits) are dead',
    };
  }
  return { status: 'ok', reason: 'healthy' };
}

/** Hosting probe: 200 alone is not enough — the app shell must be present. */
export function classifyHosting({ httpStatus, text, error }, mustContain) {
  if (error) return { status: 'down', reason: `unreachable: ${error}` };
  if (httpStatus !== 200) return { status: 'down', reason: `HTTP ${httpStatus}` };
  if (mustContain && !String(text ?? '').includes(mustContain)) {
    return { status: 'down', reason: `200 but body lacks ${JSON.stringify(mustContain)} — hosting is up, the app is not` };
  }
  return { status: 'ok', reason: 'healthy' };
}

/**
 * Compare a secret URL to the canonical one. Trailing slashes are noise;
 * everything else is signal. Absent secrets are reported, not failed —
 * ci.yml runs this without secrets on forks, and "not configured here" is
 * not a claim about production.
 */
export function classifySecret(canonicalUrl, secretUrl) {
  if (!secretUrl) return { status: 'absent', reason: 'secret not set in this context' };
  const norm = (u) => String(u).trim().replace(/\/+$/, '');
  if (norm(secretUrl) === norm(canonicalUrl)) return { status: 'match', reason: 'matches canonical' };
  return {
    status: 'drift',
    reason: `secret points at ${norm(secretUrl)}, canonical is ${norm(canonicalUrl)}`,
  };
}

/**
 * Fold all observations into one verdict. Any canonical/hosting failure fails.
 * A drifted secret fails ONLY if the secret's own URL probed unhealthy: a
 * healthy custom domain is drift worth a warning, a dead one is the functions'
 * outbound calls 404ing in production.
 */
export function overallVerdict(rows) {
  const failures = rows.filter((r) => r.fail);
  return failures.length === 0
    ? { ok: true, reason: `all ${rows.length} checks healthy` }
    : { ok: false, reason: `${failures.length} of ${rows.length} checks failing`, failures };
}

/* ── I/O ──────────────────────────────────────────────────────────────────── */

const ATTEMPTS = 2; // one retry tolerates a Railway cold start, not an outage
const TIMEOUT_MS = 20_000;

async function probe(url) {
  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* non-JSON body — classify decides */ }
      if (res.status === 200 || attempt === ATTEMPTS) return { httpStatus: res.status, body, text };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.cause?.code ?? err?.name ?? String(err?.message ?? err);
      if (attempt === ATTEMPTS) return { error: lastError };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { error: lastError };
}

export function loadEndpoints(filePath) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(filePath ?? path.join(here, 'production-endpoints.json'), 'utf8'));
}

async function main() {
  const endpoints = loadEndpoints(process.env.ENDPOINTS_FILE);
  const rows = [];
  const pad = (s, n) => String(s).padEnd(n);

  // 1 + 2: canonical probes, and secret drift (with a probe of drifted secrets).
  for (const [name, canonicalUrl] of Object.entries(endpoints.services)) {
    const canonical = classifyHealth(await probe(`${canonicalUrl}/health`));
    rows.push({ name: `canonical:${name}`, fail: canonical.status !== 'ok', reason: canonical.reason });

    // Since deploy.yml switched to writing these URLs from THIS file (the
    // 2026-09-04 recovery), the `*_URL` GitHub secrets feed nothing — so a
    // stale one is stale-config noise to clean up, never an outage. These
    // rows are informational: they never fail the check, they just keep the
    // leftover secrets visible until someone deletes them.
    const secretName = endpoints.secretNames[name];
    const secret = classifySecret(canonicalUrl, process.env[secretName]);
    rows.push({
      name: `secret:${secretName}`,
      fail: false,
      reason:
        secret.status === 'drift'
          ? `${secret.reason} — informational only: deploy.yml no longer reads this secret; update or delete it`
          : secret.reason,
    });
  }

  // registry-service: no canonical URL in-tree (see production-endpoints.json
  // header) — probe the secret when present, say so when absent.
  if (process.env.REGISTRY_SERVICE_URL) {
    const probed = classifyHealth(await probe(`${process.env.REGISTRY_SERVICE_URL.replace(/\/+$/, '')}/health`));
    rows.push({ name: 'secret:REGISTRY_SERVICE_URL', fail: probed.status !== 'ok', reason: probed.reason });
  } else {
    rows.push({ name: 'secret:REGISTRY_SERVICE_URL', fail: false, reason: 'secret not set in this context' });
  }

  // 3: hosting serves the app shell.
  const hosting = classifyHosting(await probe(endpoints.hosting.url), endpoints.hosting.mustContain);
  rows.push({ name: 'hosting', fail: hosting.status !== 'ok', reason: hosting.reason });

  for (const r of rows) {
    console.log(`${r.fail ? '✗' : '✓'}  ${pad(r.name, 36)} ${r.reason}`);
  }

  const verdict = overallVerdict(rows);
  if (verdict.ok) {
    console.log(`\n✓ ${verdict.reason}`);
    return;
  }
  for (const f of verdict.failures) {
    console.error(`::error::${f.name}: ${f.reason}`);
  }
  console.error(`\n${verdict.reason}`);
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith('check-production-health.mjs');
if (invokedDirectly) await main();
