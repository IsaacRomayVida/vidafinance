'use strict';

// Which build is answering. GET /health reports this so a deploy can be checked
// against the commit it was meant to ship, rather than assumed: merging to main
// does not redeploy this service (see .github/workflows/deploy-underwriting.yml),
// so "merged" and "live" are different claims and only the running process can
// make the second one.
//
// Only these named variables are read, never the environment at large -- the
// same process holds INTERNAL_SECRET and the Firebase service account.
//   RAILWAY_GIT_COMMIT_SHA  set by Railway for deploys from a linked GitHub repo
//   RAILWAY_DEPLOYMENT_ID   set by Railway for every deployment
// Neither is set for a local run or a deploy from `railway up`, and the commit
// then reads "unknown" rather than anything that could pass for a sha.

const { version } = require('../package.json');

const SHA = /^[0-9a-f]{7,40}$/i;
const DEPLOYMENT_ID = /^[0-9a-f-]{8,64}$/i;

function buildInfo(env = process.env) {
  const commit = String(env.RAILWAY_GIT_COMMIT_SHA || '').trim();
  const deploymentId = String(env.RAILWAY_DEPLOYMENT_ID || '').trim();
  return {
    commit: SHA.test(commit) ? commit.toLowerCase() : 'unknown',
    version,
    deploymentId: DEPLOYMENT_ID.test(deploymentId) ? deploymentId : null,
  };
}

module.exports = { buildInfo };
