#!/usr/bin/env node
/**
 * Deploy gate: is the limiter/queue Redis reachable from OUTSIDE Railway?
 *
 * The existing `Validate functions/.env` step proves only that a REDIS_URL
 * secret exists and is non-empty. That is a much weaker claim than the one the
 * runtime actually depends on, and the gap between the two is load-bearing:
 *
 *   - `functions/src/utils/redis.ts` `getRedis()` throws when REDIS_URL is
 *     unset, and ioredis rejects when the host cannot be reached.
 *   - `functions/src/utils/rateLimiter.ts` `enforceRateLimit(..., 'closed')`
 *     turns either of those into an outright refusal of the request — by
 *     design, because a limiter outage that silently lifts the only brake on
 *     spend is worse than one that is visible.
 *   - `functions/src/utils/queue.ts` throws outright when REDIS_URL is unset.
 *
 * So on a deployment where Redis is unreachable, the fail-closed limits do not
 * degrade — they refuse *every* call to generatePaymentLink, markLoanDisbursed,
 * processPayroll, approveEmployer, updateLoanStatus, submitReviewDecision and
 * the rest. That is the whole product down, not a rate limit misbehaving.
 *
 * The specific way this repo can get there is not hypothetical. SERVICES.md
 * documents service-to-service traffic over Railway private networking, and
 * `railway-setup-env.yml` defaults REDIS to
 * `redis://vida-redis.railway.internal:6379`. A `*.railway.internal` name
 * resolves ONLY inside Railway's private network. Cloud Functions run on
 * Google Cloud, so they can never resolve it — and neither can this CI runner,
 * which is what makes the check meaningful from here: the failure mode we care
 * about is unreachable from *everywhere* outside Railway, CI included.
 *
 * Calibration — this gate is deliberately not a liveness check:
 *   - hard FAIL on a structurally unreachable host (a `*.railway.internal`
 *     name, or one that does not resolve publicly at all). No deploy can make
 *     that work, so shipping fail-closed limits against it is a guaranteed
 *     outage.
 *   - WARN only on a host that resolves but refuses/times out the TCP connect.
 *     That is indistinguishable from a transient Redis blip or a maintenance
 *     window, and a deploy should not be blocked by one.
 *
 * Never prints REDIS_URL, its credentials, or its host — only the verdict.
 */

const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');

const ENV_PATH = process.argv[2] || 'functions/.env';
const CONNECT_TIMEOUT_MS = 5000;

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function readRedisUrl() {
  let contents;
  try {
    contents = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    fail(`${ENV_PATH} does not exist — the 'Write functions .env' step must run before this gate.`);
  }
  // Last assignment wins, matching dotenv, so a duplicated key can't be used to
  // smuggle an unchecked value past this gate.
  const line = contents
    .split('\n')
    .filter((l) => l.startsWith('REDIS_URL='))
    .pop();
  if (!line) fail(`${ENV_PATH} has no REDIS_URL line.`);
  return line.slice('REDIS_URL='.length).trim();
}

function parseHost(raw) {
  if (!raw) fail('REDIS_URL is empty — refusing to deploy.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Deliberately does not echo the value: it carries the Redis password.
    fail('REDIS_URL is not a parseable URL — refusing to deploy.');
  }
  if (!url.hostname) fail('REDIS_URL has no hostname — refusing to deploy.');
  return { host: url.hostname, port: url.port || '6379' };
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(port), host);
  });
}

async function main() {
  const { host, port } = parseHost(readRedisUrl());

  if (/\.railway\.internal$/i.test(host)) {
    fail(
      'REDIS_URL points at a *.railway.internal host. That name resolves only inside ' +
        "Railway's private network, and Cloud Functions run on Google Cloud — so the " +
        'limiter and the BullMQ queue can never reach it. Because the money-path rate ' +
        'limits fail CLOSED, this would refuse every loan approval, disbursement and ' +
        'payroll run, not merely disable rate limiting. Set the REDIS_URL secret to ' +
        "Railway's public TCP-proxy endpoint for this Redis instance (Railway → Redis → " +
        'Connect → Public Network) and re-run.'
    );
  }

  try {
    await dns.lookup(host);
  } catch {
    fail(
      'The REDIS_URL host does not resolve from a public network, so neither this runner ' +
        'nor the Cloud Functions runtime can reach it. With the money-path rate limits ' +
        'failing CLOSED, deploying this would refuse every loan approval, disbursement ' +
        'and payroll run. Point REDIS_URL at a publicly resolvable endpoint and re-run.'
    );
  }

  if (await tcpProbe(host, port)) {
    console.log(`REDIS_URL host resolves and accepts TCP on port ${port} — reachable from outside Railway.`);
    return;
  }

  // Resolves but will not connect. Could be a transient outage, a maintenance
  // window, or an IP allowlist that excludes CI but not Google Cloud. Not
  // grounds to block a deploy on its own.
  console.log(
    `::warning::The REDIS_URL host resolves but did not accept a TCP connection on port ${port} ` +
      `within ${CONNECT_TIMEOUT_MS}ms. That may be a transient Redis outage or an IP allowlist ` +
      'that excludes CI runners. Not blocking the deploy — but if the money-path rate limits ' +
      'start refusing requests with "Servicio no disponible temporalmente", this is the reason.'
  );
}

main().catch((e) => fail(`Redis reachability gate crashed: ${e.message}`));
