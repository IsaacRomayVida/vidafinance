/**
 * What does RAILWAY say is running, and does it agree with what we document?
 *
 * check-production-health.mjs asks the outside-in question (do the public URLs
 * answer). This asks the inside-out one: which projects/services/domains
 * actually exist under our tokens, is each watched service running, and does
 * any live domain actually serve each canonical URL in
 * scripts/production-endpoints.json.
 *
 * Why both: a month of HTTP 404s on all five service health probes (ci.yml
 * runs 31335990563, 32069677859) is explained EITHER by dead services OR by
 * stale URL secrets — and the repo has two overlapping Railway projects
 * (docs/ops/railway-project-audit.md: `observant-miracle` vs the stalled
 * `vida-backend`, with lookalike domains like payment-server-production-91c7
 * vs -b9b8). Only Railway's own inventory can tell those apart.
 *
 * Token reality, stated honestly: this repo carries RAILWAY_API_TOKEN,
 * RAILWAY_TOKEN, RAILWAY_TOKEN_STAGING and RAILWAY_TOKEN_VIDA_BACKEND, and
 * only the last is PROVEN in-tree (Project-Access-Token against project
 * e1334895, hourly, in verify-registry-funpay-deployed.yml). The others'
 * types and scopes are not observable from the repo. So this script tries
 * each candidate with both auth shapes, prints exactly which combination
 * worked, and treats "no token can see anything" as exit 2 (could not
 * observe) — loudly distinct from exit 1 (observed a mismatch). A check that
 * cannot see is not a check that passes.
 *
 * READ-ONLY by construction: the only operations are queries. It never
 * deploys, never mutates — detecting a problem and repairing it are separate
 * decisions (same contract as check-registry-funpay-deployed.mjs).
 *
 * Exit codes:
 *   0  every canonical URL is served by a live service that Railway reports
 *      as actively deployed
 *   1  MISMATCH observed — a watched service has no active deployment, or a
 *      canonical domain is served by nothing Railway can see
 *   2  UNKNOWN — no token could enumerate anything; nothing was observed
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

/* ── decisions, isolated from all I/O so they can be tested ───────────────── */

/** Hostname of a URL, lowercased; null when unparseable. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Bind each canonical endpoint to a discovered service, DOMAIN-FIRST.
 *
 * Name matching is the fallback, not the primary: Railway service names have
 * already diverged from ours once (the uptime runbook says `vida-payment-server`,
 * SERVICES.md says `payment-server`). A domain either serves the canonical URL
 * or it does not — that is the fact borrowers depend on.
 *
 * `services`: [{ id, name, projectName, environmentName, domains: [hostnames],
 *               activeDeployments: [{status}] | null }]
 * Returns [{ name, canonicalHost, service|null, via: 'domain'|'name'|null }].
 */
export function bindServices(canonical, services) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.entries(canonical).map(([name, url]) => {
    const canonicalHost = hostOf(url);
    const byDomain = services.find((s) => (s.domains ?? []).includes(canonicalHost));
    if (byDomain) return { name, canonicalHost, service: byDomain, via: 'domain' };
    const key = norm(name);
    const byName = services.find((s) => {
      const n = norm(s.name);
      return n === key || n.includes(key) || key.includes(n);
    });
    if (byName) return { name, canonicalHost, service: byName, via: 'name' };
    return { name, canonicalHost, service: null, via: null };
  });
}

/**
 * One binding → one verdict. The laggard decides; unknowns stay unknowns.
 *
 *  - unbound service            → mismatch (nothing Railway can see serves it)
 *  - bound by NAME only         → mismatch (the service exists but none of its
 *    domains is the canonical one — the documented URL cannot be reaching it)
 *  - deployments unobservable   → unknown (a failed read is not evidence)
 *  - zero active deployments    → mismatch (nothing is running)
 *  - active deployments present → ok, statuses listed (reachability is the
 *    health checker's question, not this one's)
 */
export function bindingVerdict(binding) {
  const { name, canonicalHost, service, via } = binding;
  if (!service) {
    return {
      status: 'mismatch',
      reason: `${name}: no visible Railway service serves ${canonicalHost} (by domain or name) — ` +
        'either the service is gone, or it lives in a project our tokens cannot see',
    };
  }
  if (via === 'name') {
    if (service.domains === null) {
      return {
        status: 'unknown',
        reason: `${name}: matched service "${service.name}" by name but its domains could not be read, so ` +
          `whether it serves ${canonicalHost} is unobserved`,
      };
    }
    return {
      status: 'mismatch',
      reason: `${name}: matched service "${service.name}" in ${service.projectName}/${service.environmentName} ` +
        `by NAME, but none of its domains [${service.domains.join(', ') || 'none'}] is ${canonicalHost} — ` +
        'the documented URL cannot be reaching it',
    };
  }
  if (service.activeDeployments === null) {
    return {
      status: 'unknown',
      reason: `${name}: bound to "${service.name}" by domain, but its deployments could not be read — ` +
        'a failed read, not evidence about the service',
    };
  }
  if (service.activeDeployments.length === 0) {
    return {
      status: 'mismatch',
      reason: `${name}: "${service.name}" serves ${canonicalHost} but Railway reports NO active deployment — nothing is running`,
    };
  }
  const statuses = service.activeDeployments.map((d) => d.status ?? '?').join(', ');
  return {
    status: 'ok',
    reason: `${name}: "${service.name}" (${service.projectName}/${service.environmentName}) live, deployments: ${statuses}`,
  };
}

/** Worst verdict wins; `unknown` outranks `ok` — a missing observation must not be outvoted. */
export function overallVerdict(verdicts, observedAnything) {
  if (!observedAnything) {
    return {
      exit: 2,
      reason:
        'No Railway token in this run could enumerate any project. Nothing was observed — this is ' +
        'NOT a claim about production. Fix the token (see the strategy log above) and re-run.',
    };
  }
  if (verdicts.some((v) => v.status === 'mismatch')) {
    return { exit: 1, reason: 'MISMATCH between production-endpoints.json and what Railway is actually running — see above.' };
  }
  if (verdicts.some((v) => v.status === 'unknown')) {
    return { exit: 2, reason: 'Some services could not be observed — not a pass, not a mismatch claim.' };
  }
  return { exit: 0, reason: 'Every canonical endpoint is served by a live, actively-deployed Railway service.' };
}

/* ── I/O ──────────────────────────────────────────────────────────────────── */

function gql(query, variables, headers) {
  const out = execFileSync(
    'curl',
    ['-sS', '--max-time', '30', RAILWAY_API, '-H', 'Content-Type: application/json',
     ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
     '--data', JSON.stringify({ query, variables })],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);
  if (parsed.errors) {
    // Railway answers auth failures AND nonexistent ids with HTTP 200 + errors.
    throw new Error(parsed.errors.map((e) => e.message).join('; '));
  }
  return parsed.data;
}

const PROJECT_FIELDS =
  '{ id name environments { edges { node { id name } } } services { edges { node { id name } } } }';

/**
 * Try every (token, auth-shape, root-query) combination and return the first
 * that yields projects, logging each attempt's outcome by NAME (never value).
 */
function enumerateProjects(log) {
  const candidates = [
    ['RAILWAY_API_TOKEN', process.env.RAILWAY_API_TOKEN],
    ['RAILWAY_TOKEN', process.env.RAILWAY_TOKEN],
    ['RAILWAY_TOKEN_VIDA_BACKEND', process.env.RAILWAY_TOKEN_VIDA_BACKEND],
  ].filter(([, v]) => v);

  for (const [tokenName, token] of candidates) {
    // Account/team tokens: Bearer + a projects listing (two shapes tried,
    // because the reachable shape depends on token type and neither is
    // provable from this repo).
    for (const [label, query, pick] of [
      ['projects', `query { projects { edges { node ${PROJECT_FIELDS} } } }`,
        (d) => d?.projects?.edges?.map((e) => e.node)],
      ['me.projects', `query { me { projects { edges { node ${PROJECT_FIELDS} } } } }`,
        (d) => d?.me?.projects?.edges?.map((e) => e.node)],
    ]) {
      try {
        const projects = pick(gql(query, {}, { Authorization: `Bearer ${token}` }));
        if (projects?.length) {
          log(`✓ enumerated ${projects.length} project(s) via ${tokenName} (Bearer, ${label})`);
          return { projects, headers: { Authorization: `Bearer ${token}` }, tokenName };
        }
        log(`- ${tokenName} (Bearer, ${label}): authenticated but zero projects visible`);
      } catch (err) {
        log(`- ${tokenName} (Bearer, ${label}): ${err.message}`);
      }
    }
    // Project tokens: introspect which single project they unlock, then read it.
    try {
      const headers = { 'Project-Access-Token': token };
      const scope = gql('query { projectToken { projectId environmentId } }', {}, headers)?.projectToken;
      if (scope?.projectId) {
        const project = gql(`query($id: String!) { project(id: $id) ${PROJECT_FIELDS} }`, { id: scope.projectId }, headers)?.project;
        if (project) {
          log(`✓ enumerated project "${project.name}" via ${tokenName} (Project-Access-Token)`);
          return { projects: [project], headers, tokenName };
        }
      }
      log(`- ${tokenName} (Project-Access-Token): introspection returned no projectId`);
    } catch (err) {
      log(`- ${tokenName} (Project-Access-Token): ${err.message}`);
    }
  }
  if (!candidates.length) log('- no Railway token env vars are set at all');
  return null;
}

/** Domains of one service instance; null (unobservable) on any read failure. */
function serviceDomains(projectId, environmentId, serviceId, headers, log) {
  try {
    const d = gql(
      'query($p: String!, $e: String!, $s: String!) { domains(projectId: $p, environmentId: $e, serviceId: $s) ' +
        '{ serviceDomains { domain } customDomains { domain } } }',
      { p: projectId, e: environmentId, s: serviceId },
      headers
    )?.domains;
    return [...(d?.serviceDomains ?? []), ...(d?.customDomains ?? [])]
      .map((x) => String(x.domain).toLowerCase());
  } catch (err) {
    log(`  (domains unreadable for service ${serviceId.slice(0, 8)}: ${err.message})`);
    return null;
  }
}

/** Active deployments of one service instance; null (unobservable) on failure. */
function activeDeployments(serviceId, environmentId, headers, log) {
  try {
    const actives = gql(
      'query($sid: String!, $eid: String!) { serviceInstance(serviceId: $sid, environmentId: $eid) ' +
        '{ activeDeployments { id status } } }',
      { sid: serviceId, eid: environmentId },
      headers
    )?.serviceInstance?.activeDeployments;
    return Array.isArray(actives) ? actives : null;
  } catch (err) {
    log(`  (deployments unreadable for service ${serviceId.slice(0, 8)}: ${err.message})`);
    return null;
  }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const endpoints = JSON.parse(
    readFileSync(process.env.ENDPOINTS_FILE ?? path.join(here, 'production-endpoints.json'), 'utf8')
  );
  const log = (s) => console.log(s);

  log('token strategy:');
  const enumerated = enumerateProjects(log);
  if (!enumerated) {
    const v = overallVerdict([], false);
    console.error(`::error::${v.reason}`);
    process.exit(v.exit);
  }

  // Full inventory, printed BEFORE any verdict: when this run does find a
  // mismatch, the very next question is "so where IS everything", and the
  // answer should already be in the log.
  const flat = [];
  for (const project of enumerated.projects) {
    const environments = project.environments?.edges?.map((e) => e.node) ?? [];
    const services = project.services?.edges?.map((e) => e.node) ?? [];
    log(`\nproject "${project.name}" (${project.id})`);
    for (const environment of environments) {
      log(`  environment "${environment.name}" (${environment.id})`);
      for (const service of services) {
        const domains = serviceDomains(project.id, environment.id, service.id, enumerated.headers, log);
        const actives = activeDeployments(service.id, environment.id, enumerated.headers, log);
        const statuses = actives === null ? '?' : actives.map((d) => d.status).join(',') || 'NONE ACTIVE';
        log(`    ${service.name}: domains=[${domains === null ? '?' : domains.join(', ') || 'none'}] deployments=${statuses}`);
        flat.push({
          id: service.id,
          name: service.name,
          projectName: project.name,
          environmentName: environment.name,
          domains,
          activeDeployments: actives,
        });
      }
    }
  }

  log('\nreconciliation against scripts/production-endpoints.json:');
  const verdicts = bindServices(endpoints.services, flat).map(bindingVerdict);
  for (const v of verdicts) log(`  ${v.status === 'ok' ? '✓' : '✗'} ${v.reason}`);

  const verdict = overallVerdict(verdicts, true);
  if (verdict.exit === 0) {
    log(`\n✓ ${verdict.reason}`);
    return;
  }
  console.error(`::error::${verdict.reason}`);
  process.exit(verdict.exit);
}

const invokedDirectly = process.argv[1]?.endsWith('check-railway-live.mjs');
if (invokedDirectly) main();
