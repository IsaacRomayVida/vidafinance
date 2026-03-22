/**
 * CI/CD Workflow Audit Tests — VID3-178
 *
 * These tests validate the GitHub Actions workflow files for known
 * configuration issues discovered during the CI/CD audit.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const WORKFLOWS_DIR = path.resolve(__dirname, "../.github/workflows");

function loadWorkflow(filename) {
  const filepath = path.join(WORKFLOWS_DIR, filename);
  return yaml.load(fs.readFileSync(filepath, "utf8"));
}

describe("CI/CD Workflow Audit", () => {
  // ─── Issue 1: eslint missing from functions/package.json ───
  describe("CI workflow — eslint dependency", () => {
    it("functions/package.json should include eslint in devDependencies", () => {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, "../functions/package.json"),
          "utf8"
        )
      );
      const devDeps = pkg.devDependencies || {};
      // BUG: eslint is not listed but ci.yml runs `npm run lint` which calls `eslint`
      expect(devDeps).toHaveProperty("eslint");
    });
  });

  // ─── Issue 2: Firebase service account secret is invalid JSON ───
  describe("Deploy Firebase — authentication", () => {
    it("firebase-deploy.yml should use correct secret per environment", () => {
      const wf = loadWorkflow("firebase-deploy.yml");
      const steps = wf.jobs.deploy.steps;
      const authStep = steps.find(
        (s) => s.name === "Authenticate to Google Cloud"
      );

      // Both deploy.yml and firebase-deploy.yml hardcode FIREBASE_SERVICE_ACCOUNT_STAGING
      // even for production deploys on main branch. The secret value is also
      // reported as "not a valid Google Service Account Key JSON".
      //
      // BUG: The credentials_json should use the correct secret per environment:
      //   - staging:    FIREBASE_SERVICE_ACCOUNT_STAGING
      //   - production: FIREBASE_SERVICE_ACCOUNT_PRODUCTION
      const credentialsExpr = authStep.with.credentials_json;
      // Should reference both PRODUCTION and STAGING secrets conditionally
      expect(credentialsExpr).toContain("FIREBASE_SERVICE_ACCOUNT_PRODUCTION");
      expect(credentialsExpr).toContain("FIREBASE_SERVICE_ACCOUNT_STAGING");
    });
  });

  // ─── Issue 3: Production deploy targets staging project ───
  describe("deploy.yml — production Firebase project", () => {
    it("production deploy step should use FIREBASE_PROJECT_ID_PRODUCTION, not STAGING", () => {
      const wf = loadWorkflow("deploy.yml");
      const firebaseJob = wf.jobs["deploy-firebase"];
      const prodStep = firebaseJob.steps.find(
        (s) => s.name === "Deploy to Firebase (Production)"
      );

      // BUG: Line 159 of deploy.yml uses FIREBASE_PROJECT_ID_STAGING for the
      // production deploy (when github.ref == 'refs/heads/main').
      // It should use FIREBASE_PROJECT_ID_PRODUCTION.
      expect(prodStep.run).toContain("FIREBASE_PROJECT_ID_PRODUCTION");
      expect(prodStep.run).not.toContain("FIREBASE_PROJECT_ID_STAGING");
    });

    it("firebase-deploy.yml production deploy should also use PRODUCTION project ID", () => {
      const wf = loadWorkflow("firebase-deploy.yml");
      const steps = wf.jobs.deploy.steps;
      const prodStep = steps.find(
        (s) => s.name === "Deploy Firebase (Production)"
      );

      // Same bug in firebase-deploy.yml line 76
      expect(prodStep.run).toContain("FIREBASE_PROJECT_ID_PRODUCTION");
      expect(prodStep.run).not.toContain("FIREBASE_PROJECT_ID_STAGING");
    });
  });

  // ─── Issue 4: Duplicate/overlapping workflows ───
  describe("Workflow overlap", () => {
    it("should not have both deploy.yml and firebase-deploy.yml deploying Firebase on push to main", () => {
      const deploy = loadWorkflow("deploy.yml");
      const firebaseDeploy = loadWorkflow("firebase-deploy.yml");

      const deployTriggers = deploy.on.push.branches;
      // firebase-deploy.yml should use workflow_dispatch (no push trigger)
      const firebaseDeployPush = firebaseDeploy.on.push;

      expect(firebaseDeployPush).toBeUndefined();
    });
  });
});
