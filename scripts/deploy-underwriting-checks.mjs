#!/usr/bin/env node
/**
 * The two decisions .github/workflows/deploy-underwriting.yml makes, kept out of
 * shell so they can be tested. All Railway and HTTP I/O stays in the workflow;
 * this file only reads JSON it is handed and answers with an exit code.
 *
 * 1. WHICH SERVICE TO DEPLOY (`resolve`)
 *
 * The repo does not record underwriting-service's Railway service id, and
 * guessing one is not an option: Railway answers a nonexistent id with the same
 * "Not Authorized" it uses for a bad token, so a wrong id misdirects whoever is
 * on call. So the workflow lists the services in FunPay/production and this
 * picks the one serving the canonical host in scripts/production-endpoints.json
 * — the same domain-first binding scripts/check-railway-live.mjs uses — and
 * additionally requires its Railway name to be the expected one. Zero matches,
 * several, an unreadable domain list or a name mismatch all fail closed: the
 * deploy does not happen.
 *
 * Unreadable domains (null) are treated as "might be the one". Skipping them
 * would let a single failed read turn an ambiguous inventory into a confident
 * unique match.
 *
 * 2. WHETHER THE DEPLOY IS LIVE (`health`)
 *
 * After Railway reports SUCCESS, GET /health must report the commit Railway says
 * it built. Verdicts:
 *   match    — commit matches (and, if /health names a deployment, it is the new one)
 *   wait     — an older container is still answering; poll again
 *   fail     — the new deployment is answering and can never report the commit
 *
 * RUN
 *
 *   node scripts/deploy-underwriting-checks.mjs resolve <services.json> <endpoints.json> <name>
 *     services.json: [{ id, name, domains: [host] | null }]
 *     prints the service id on success; exit 1 with ::error:: otherwise
 *
 *   node scripts/deploy-underwriting-checks.mjs health <health.json> <commit> [deploymentId]
 *     exit 0 match, 1 fail, 3 wait — the reason is printed either way
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENDPOINT_KEY = 'underwriting-service';

/** Lower-cased hostname of a URL, or null if it is not one. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Picks the one service serving `host`, and insists it is called `name`.
 * Returns { id, name } or { error }.
 */
export function pickService(services, { host, name }) {
  if (!host) return { error: `no canonical host for ${ENDPOINT_KEY} in production-endpoints.json` };
  if (!Array.isArray(services) || services.length === 0) {
    return { error: 'Railway listed no services in this project/environment — nothing to match against' };
  }

  const unreadable = services.filter((s) => s.domains === null || s.domains === undefined);
  const matches = services.filter((s) => (s.domains ?? []).map((d) => String(d).toLowerCase()).includes(host));

  if (unreadable.length) {
    return {
      error:
        `domains could not be read for ${unreadable.map((s) => `"${s.name}"`).join(', ')}, so it is not ` +
        `known which service serves ${host}. Not guessing — re-run once Railway answers.`,
    };
  }
  if (matches.length === 0) {
    return {
      error:
        `no service in this environment serves ${host}. Either the domain moved (update ` +
        `scripts/production-endpoints.json) or the service is gone. Seen: ` +
        services.map((s) => `"${s.name}" [${(s.domains ?? []).join(', ') || 'no domains'}]`).join('; '),
    };
  }
  if (matches.length > 1) {
    return {
      error: `${matches.length} services serve ${host} (${matches.map((s) => `"${s.name}" ${s.id}`).join(', ')}); refusing to pick one`,
    };
  }

  const [service] = matches;
  if (service.name !== name) {
    return {
      error:
        `${host} is served by "${service.name}" (${service.id}), not "${name}". The canonical domain ` +
        'and the service name disagree; confirm which is the underwriting service before deploying, then ' +
        'fix whichever is stale (production-endpoints.json or RAILWAY_SERVICE_NAME in the workflow).',
    };
  }
  return { id: service.id, name: service.name };
}

const SHA = /^[0-9a-f]{7,40}$/i;

/** Verdict on one /health body against the deployment Railway reported. */
export function healthVerdict(body, { commit, deploymentId = null }) {
  if (!commit || !SHA.test(commit)) {
    return {
      verdict: 'fail',
      reason: `Railway reported no usable commit for the new deployment ("${commit || ''}"), so there is nothing to verify /health against`,
    };
  }
  const expected = commit.toLowerCase();

  if (!body || typeof body !== 'object') {
    return { verdict: 'wait', reason: '/health did not return a JSON object' };
  }

  // A build from before /health reported its commit has no `commit` key at all.
  // That can only be the old container, so it is worth waiting for the switch.
  if (!('commit' in body)) {
    return { verdict: 'wait', reason: '/health has no commit field — the previous build is still answering' };
  }

  const reported = String(body.commit).toLowerCase();
  const isNewDeployment = Boolean(deploymentId && body.deploymentId && body.deploymentId === deploymentId);

  if (reported === expected) {
    if (deploymentId && body.deploymentId && body.deploymentId !== deploymentId) {
      // Same code, older container (a redeploy of an unchanged commit). The code
      // is what this check is about, but say which container answered.
      return {
        verdict: 'match',
        reason: `commit ${expected.slice(0, 8)} is live (answered by deployment ${body.deploymentId}, not ${deploymentId} — same commit)`,
      };
    }
    return { verdict: 'match', reason: `commit ${expected.slice(0, 8)} is live` };
  }

  if (reported === 'unknown' && isNewDeployment) {
    return {
      verdict: 'fail',
      reason:
        `the new deployment ${deploymentId} is answering but reports commit "unknown": Railway did not set ` +
        'RAILWAY_GIT_COMMIT_SHA for it. The deploy happened; this check cannot confirm what it runs.',
    };
  }
  if (isNewDeployment) {
    return {
      verdict: 'fail',
      reason: `the new deployment ${deploymentId} reports commit ${reported.slice(0, 8)}, but Railway built ${expected.slice(0, 8)}`,
    };
  }
  return {
    verdict: 'wait',
    reason: `/health reports commit ${reported === 'unknown' ? 'unknown' : reported.slice(0, 8)}, waiting for ${expected.slice(0, 8)}`,
  };
}

const EXIT = { match: 0, fail: 1, wait: 3 };

function main(argv) {
  const [command, ...args] = argv;

  if (command === 'resolve') {
    const [servicesPath, endpointsPath, name] = args;
    const services = JSON.parse(readFileSync(servicesPath, 'utf8'));
    const endpoints = JSON.parse(readFileSync(endpointsPath, 'utf8'));
    const result = pickService(services, { host: hostOf(endpoints?.services?.[ENDPOINT_KEY]), name });
    if (result.error) {
      console.error(`::error::${result.error}`);
      return 1;
    }
    console.log(result.id);
    return 0;
  }

  if (command === 'health') {
    const [healthPath, commit, deploymentId] = args;
    let body = null;
    try {
      body = JSON.parse(readFileSync(healthPath, 'utf8'));
    } catch {
      body = null;
    }
    const { verdict, reason } = healthVerdict(body, { commit, deploymentId: deploymentId || null });
    console.log(reason);
    return EXIT[verdict];
  }

  console.error('usage: deploy-underwriting-checks.mjs resolve <services.json> <endpoints.json> <name>');
  console.error('       deploy-underwriting-checks.mjs health <health.json> <commit> [deploymentId]');
  return 2;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
