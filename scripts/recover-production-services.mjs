/**
 * Bring back production services that are FULLY DOWN — and touch nothing else.
 *
 * Found live on 2026-09-04 (verify-production-live run 33918482954):
 * `softcredito-adapter` and `underwriting-service` had ZERO active deployments
 * in observant-miracle/production (SPEI disbursement, payroll deductions and
 * the entire credit pipeline offline), and the shared `Redis` service showed
 * NONE ACTIVE — which explains ml-service reporting "degraded" and the other
 * services' health endpoints hanging. Fixing that meant clicking the Railway
 * dashboard, and the working model here is workflows over dashboards.
 *
 * THE ONE RULE, stated first because everything else follows from it:
 * **a service with one or more active deployments is NEVER touched.** This
 * script only acts on services Railway itself reports as running NOTHING —
 * and redeploying a service that is fully down cannot make it more down, and
 * cannot move money by itself (every money mutation behind these services
 * carries its own idempotency guard — #561, #562, #578). That is what makes
 * it safe to run on every push to main as a standing self-healing pass: when
 * production is healthy it is a read-only no-op.
 *
 * Division of labour, same as the registry pair: verify-production-live.yml
 * DETECTS and never repairs; this repairs and only what detection logic
 * (the same domain-first binding) says is fully down. Two workflows, so a
 * repair failure can never mask a detection.
 *
 * Actions per state:
 *   - bound service, 0 active deployments  → `serviceInstanceDeploy(latestCommit: true)`
 *     (the exact mutation deploy-registry-funpay.yml has used in production)
 *   - `Redis` in the same environment, 0 active → `serviceInstanceRedeploy`
 *     (image-based service — no repo to build; Railway volumes survive a
 *     redeploy, and a Redis that is already NOT running has nothing left to
 *     lose by restarting)
 *   - unbound / unobservable state          → MANUAL: reported, never guessed at
 *
 * After submitting, each triggered service is polled until it shows an active
 * SUCCESS deployment or the window closes. Exit codes are a contract:
 *   0  nothing needed, or every needed recovery submitted AND confirmed live
 *   1  a needed recovery could not be submitted, or did not come up in the
 *      window — read the log; the state is named per service
 *   2  Railway could not be enumerated at all — nothing observed, nothing done
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindServices } from './check-railway-live.mjs';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

/* ── decisions, isolated from I/O so they can be tested ───────────────────── */

/**
 * What to do for each canonical binding plus the environment's Redis.
 * `bindings` come from bindServices(); `allServices` is the flat inventory.
 * Returns [{ action: 'none'|'deploy'|'redeploy'|'manual', name, service?, reason }].
 */
export function planRecovery(bindings, allServices) {
  const plan = bindings.map((b) => {
    if (!b.service) {
      return {
        action: 'manual',
        name: b.name,
        reason: `${b.name}: no Railway service serves ${b.canonicalHost} — nothing safe to deploy; create/link the service by hand`,
      };
    }
    if (b.service.activeDeployments === null) {
      return {
        action: 'manual',
        name: b.name,
        reason: `${b.name}: deployment state unreadable — acting on an unobserved state is how healthy services get redeployed`,
      };
    }
    if (b.service.activeDeployments.length === 0) {
      return {
        action: 'deploy',
        name: b.name,
        service: b.service,
        reason: `${b.name}: "${b.service.name}" has ZERO active deployments — submitting serviceInstanceDeploy(latestCommit: true)`,
      };
    }
    return { action: 'none', name: b.name, reason: `${b.name}: already running (${b.service.activeDeployments.length} active)` };
  });

  // Redis rides along only in environments that host at least one bound
  // canonical service — never in unrelated projects.
  const boundEnvs = new Set(
    bindings.filter((b) => b.service).map((b) => `${b.service.projectName}/${b.service.environmentName}`)
  );
  for (const s of allServices) {
    if (s.name !== 'Redis') continue;
    if (!boundEnvs.has(`${s.projectName}/${s.environmentName}`)) continue;
    if (s.activeDeployments === null) {
      plan.push({ action: 'manual', name: `Redis (${s.projectName})`, reason: `Redis in ${s.projectName}: state unreadable — not acting on it` });
    } else if (s.activeDeployments.length === 0) {
      plan.push({
        action: 'redeploy',
        name: `Redis (${s.projectName})`,
        service: s,
        reason: `Redis in ${s.projectName}/${s.environmentName}: ZERO active deployments — every BullMQ queue is down; submitting serviceInstanceRedeploy`,
      });
    } else {
      plan.push({ action: 'none', name: `Redis (${s.projectName})`, reason: `Redis in ${s.projectName}: already running` });
    }
  }
  return plan;
}

/** Fold poll results into the final verdict. */
export function recoveryVerdict(plan, outcomes) {
  const needed = plan.filter((p) => p.action === 'deploy' || p.action === 'redeploy');
  const manual = plan.filter((p) => p.action === 'manual');
  const failed = outcomes.filter((o) => !o.ok);
  if (needed.length === 0 && manual.length === 0) return { exit: 0, reason: 'Nothing to recover — every watched service is running.' };
  if (failed.length === 0 && manual.length === 0) return { exit: 0, reason: `Recovered ${needed.length} service(s); all confirmed live.` };
  return {
    exit: 1,
    reason:
      `${failed.length} recovery(ies) not confirmed live and ${manual.length} need manual action — see per-service lines above. ` +
      'The 2-hourly verify-production-live run stays red until this is resolved.',
  };
}

/* ── I/O ──────────────────────────────────────────────────────────────────── */

function gql(query, variables, token) {
  const out = execFileSync(
    'curl',
    ['-sS', '--max-time', '30', RAILWAY_API, '-H', 'Content-Type: application/json',
     '-H', `Authorization: Bearer ${token}`, '--data', JSON.stringify({ query, variables })],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(out);
  if (parsed.errors) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data;
}

const PROJECT_FIELDS =
  '{ id name environments { edges { node { id name } } } services { edges { node { id name } } } }';

function inventory(token, log) {
  const projects = gql(`query { projects { edges { node ${PROJECT_FIELDS} } } }`, {}, token)
    ?.projects?.edges?.map((e) => e.node);
  if (!projects?.length) throw new Error('token authenticated but zero projects visible');
  const flat = [];
  for (const project of projects) {
    for (const environment of project.environments?.edges?.map((e) => e.node) ?? []) {
      for (const service of project.services?.edges?.map((e) => e.node) ?? []) {
        let domains = null;
        let actives = null;
        try {
          const d = gql(
            'query($p: String!, $e: String!, $s: String!) { domains(projectId: $p, environmentId: $e, serviceId: $s) { serviceDomains { domain } customDomains { domain } } }',
            { p: project.id, e: environment.id, s: service.id }, token
          )?.domains;
          domains = [...(d?.serviceDomains ?? []), ...(d?.customDomains ?? [])].map((x) => String(x.domain).toLowerCase());
        } catch (err) { log(`  (domains unreadable for ${service.name}: ${err.message})`); }
        try {
          const a = gql(
            'query($sid: String!, $eid: String!) { serviceInstance(serviceId: $sid, environmentId: $eid) { activeDeployments { id status } } }',
            { sid: service.id, eid: environment.id }, token
          )?.serviceInstance?.activeDeployments;
          actives = Array.isArray(a) ? a : null;
        } catch (err) { log(`  (deployments unreadable for ${service.name}: ${err.message})`); }
        flat.push({
          id: service.id, name: service.name, projectId: project.id, projectName: project.name,
          environmentId: environment.id, environmentName: environment.name, domains, activeDeployments: actives,
        });
      }
    }
  }
  return flat;
}

function submit(item, token, log) {
  const { service } = item;
  try {
    if (item.action === 'deploy') {
      gql(
        'mutation($sid: String!, $eid: String!) { serviceInstanceDeploy(serviceId: $sid, environmentId: $eid, latestCommit: true) }',
        { sid: service.id, eid: service.environmentId }, token
      );
    } else {
      gql(
        'mutation($sid: String!, $eid: String!) { serviceInstanceRedeploy(serviceId: $sid, environmentId: $eid) }',
        { sid: service.id, eid: service.environmentId }, token
      );
    }
    log(`→ submitted ${item.action} for ${item.name}`);
    return true;
  } catch (err) {
    log(`✗ ${item.action} for ${item.name} REFUSED by Railway: ${err.message} — this one needs the dashboard`);
    return false;
  }
}

async function pollLive(item, token, log, deadlineMs) {
  const { service } = item;
  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      const actives = gql(
        'query($sid: String!, $eid: String!) { serviceInstance(serviceId: $sid, environmentId: $eid) { activeDeployments { id status } } }',
        { sid: service.id, eid: service.environmentId }, token
      )?.serviceInstance?.activeDeployments ?? [];
      const statuses = actives.map((d) => d.status).join(',') || 'none yet';
      log(`  ${item.name}: ${statuses}`);
      if (actives.some((d) => d.status === 'SUCCESS')) return { name: item.name, ok: true };
      if (actives.some((d) => ['FAILED', 'CRASHED'].includes(d.status))) {
        return { name: item.name, ok: false, why: `deployment ended ${statuses}` };
      }
    } catch (err) {
      log(`  ${item.name}: poll read failed (${err.message}) — retrying`);
    }
  }
  return { name: item.name, ok: false, why: 'no SUCCESS deployment before the window closed — check Railway build logs' };
}

async function main() {
  const token = process.env.RAILWAY_API_TOKEN;
  const log = (s) => console.log(s);
  if (!token) {
    console.error('::error::RAILWAY_API_TOKEN is not set — cannot observe or recover anything.');
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const endpoints = JSON.parse(readFileSync(path.join(here, 'production-endpoints.json'), 'utf8'));

  let flat;
  try {
    flat = inventory(token, log);
  } catch (err) {
    console.error(`::error::Could not enumerate Railway (${err.message}) — nothing observed, nothing done.`);
    process.exit(2);
  }

  const plan = planRecovery(bindServices(endpoints.services, flat), flat);
  for (const p of plan) log(`${p.action === 'none' ? '✓' : p.action === 'manual' ? '✗' : '!'} ${p.reason}`);

  const toRun = plan.filter((p) => p.action === 'deploy' || p.action === 'redeploy');
  // Redis first: the app services' health depends on it, so bringing them up
  // against a dead Redis just moves the failure one layer deeper.
  toRun.sort((a, b) => (a.action === 'redeploy' ? -1 : 0) - (b.action === 'redeploy' ? -1 : 0));

  const outcomes = [];
  const deadlineMs = Date.now() + 12 * 60_000;
  for (const item of toRun) {
    if (!submit(item, token, log)) {
      outcomes.push({ name: item.name, ok: false, why: 'mutation refused' });
    }
  }
  const submitted = toRun.filter((i) => !outcomes.some((o) => o.name === i.name));
  if (submitted.length) log('\npolling until live (or window closes):');
  for (const item of submitted) outcomes.push(await pollLive(item, token, log, deadlineMs));

  const verdict = recoveryVerdict(plan, outcomes);
  if (verdict.exit === 0) {
    log(`\n✓ ${verdict.reason}`);
    return;
  }
  console.error(`::error::${verdict.reason}`);
  process.exit(verdict.exit);
}

const invokedDirectly = process.argv[1]?.endsWith('recover-production-services.mjs');
if (invokedDirectly) await main();
