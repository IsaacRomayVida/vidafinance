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

// Matches the shell pattern every "which Firebase project do I deploy to?"
// step uses: branch on github.ref, then pull the project ID from the
// PRODUCTION secret on main and the STAGING secret otherwise. This is a
// ROLE match (what the step's `run` actually does), not a display-name
// match, so it keeps working if a step gets renamed for cosmetic reasons —
// which is exactly what rotted this test once already (the step this test
// looks for was renamed from "Deploy to Firebase (Production)" to plain
// "Deploy to Firebase").
const PROJECT_SELECTOR_RE =
  /if\s*\[\s*"\$\{\{\s*github\.ref\s*\}\}"\s*=\s*"refs\/heads\/main"\s*\]\s*;\s*then\s*\n\s*PROJECT="\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}"\s*\n\s*else\s*\n\s*PROJECT="\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}"/;

// Finds every step in a job whose `run` selects a Firebase project by this
// pattern, regardless of what the step is named.
function findProjectSelectorSteps(job) {
  return (job.steps || []).filter(
    (s) => typeof s.run === "string" && PROJECT_SELECTOR_RE.test(s.run)
  );
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
    it("every step that selects a Firebase project target must route main to PRODUCTION and everything else to STAGING", () => {
      const wf = loadWorkflow("deploy.yml");
      const firebaseJob = wf.jobs["deploy-firebase"];
      const selectorSteps = findProjectSelectorSteps(firebaseJob);

      // Fail loudly and specifically if the pattern can't be found at all —
      // e.g. the branching logic itself was rewritten — instead of throwing
      // a TypeError from indexing into `undefined`.
      if (selectorSteps.length === 0) {
        const stepNames = (firebaseJob.steps || [])
          .map((s) => JSON.stringify(s.name))
          .join(", ");
        throw new Error(
          `Expected at least one step in deploy.yml's "deploy-firebase" job ` +
            `whose \`run\` selects a Firebase PROJECT via an ` +
            `"if github.ref == refs/heads/main" branch (looked for a shell ` +
            `if/else assigning PROJECT from secrets.FIREBASE_PROJECT_ID_* in ` +
            `each arm). Found none among steps named: ${stepNames}. If this ` +
            `pattern was intentionally restructured, update ` +
            `PROJECT_SELECTOR_RE in tests/ci-workflow-audit.test.js to match ` +
            `the new shape — do not delete this guard, it exists because a ` +
            `real production/staging deploy mixup happened once.`
        );
      }

      // BUG this guards against: a step using FIREBASE_PROJECT_ID_STAGING
      // for the production deploy (when github.ref == 'refs/heads/main'),
      // or vice versa. Every matched step's main-branch arm must resolve to
      // PRODUCTION and its else arm must resolve to STAGING.
      const misrouted = selectorSteps
        .map((step) => {
          const [, mainBranchSecret, elseBranchSecret] =
            step.run.match(PROJECT_SELECTOR_RE);
          return { name: step.name, mainBranchSecret, elseBranchSecret };
        })
        .filter(
          ({ mainBranchSecret, elseBranchSecret }) =>
            mainBranchSecret !== "FIREBASE_PROJECT_ID_PRODUCTION" ||
            elseBranchSecret !== "FIREBASE_PROJECT_ID_STAGING"
        );

      expect(misrouted).toEqual([]);
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
