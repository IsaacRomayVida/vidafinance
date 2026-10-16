"use strict";
/**
 * GET /health reports which build is answering.
 *
 * Merging to main does not redeploy this service, so whether a merged change is
 * live can only be answered by the running process. deploy-underwriting.yml
 * reads `commit` from this endpoint after a deploy and fails unless it is the
 * commit Railway says it deployed -- so the field's shape is a contract, and a
 * field that silently disappeared would turn that check into a permanent red
 * (or, worse, someone "fixing" the workflow to stop checking).
 *
 * The secret-leak cases matter as much as the happy path: /health is
 * unauthenticated, and the same process holds INTERNAL_SECRET and the Firebase
 * service account.
 */
const http = require("http");

jest.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: jest.fn(() => ({ add: jest.fn(), doc: jest.fn() })),
  });
  firestore.FieldValue = { serverTimestamp: () => "SERVER_TIMESTAMP" };
  return {
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    firestore,
  };
});

jest.mock("ioredis", () =>
  jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue("PONG"),
    disconnect: jest.fn(),
    on: jest.fn(),
  })),
);

const SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@test.iam.gserviceaccount.com",
});
const INTERNAL_SECRET = "health-suite-internal-secret";

process.env.FIREBASE_SERVICE_ACCOUNT = SERVICE_ACCOUNT;
process.env.REDIS_URL = "redis://localhost:6379";
process.env.INTERNAL_SECRET = INTERNAL_SECRET;
process.env.METAMAP_WEBHOOK_SECRET = "health-suite-webhook-secret";

const { version } = require("../package.json");
const { buildInfo } = require("./build-info");

const SAVED = {
  RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
  RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID,
};

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A fresh module registry per load: BUILD is read once at module load, and
// jest keeps its own registry, so deleting from require.cache is not enough.
function loadApp() {
  let app;
  jest.isolateModules(() => {
    app = require("../index");
  });
  return app;
}

function getHealth(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      http
        .get({ hostname: "127.0.0.1", port: server.address().port, path: "/health" }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, raw: data, body: JSON.parse(data) });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const SHA = "427185d0c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6";
const DEPLOYMENT = "7d1c2b3a-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

describe("GET /health build fields", () => {
  it("reports the commit and deployment Railway set, plus the package version", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = SHA;
    process.env.RAILWAY_DEPLOYMENT_ID = DEPLOYMENT;
    const res = await getHealth(loadApp());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "vida-underwriting-service",
      commit: SHA,
      version,
      deploymentId: DEPLOYMENT,
    });
  });

  it('reports commit "unknown" when Railway set no commit (local run, `railway up`)', async () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.RAILWAY_DEPLOYMENT_ID;
    const res = await getHealth(loadApp());

    expect(res.body.commit).toBe("unknown");
    expect(res.body.deploymentId).toBeNull();
    expect(res.body.version).toBe(version);
  });

  it("never echoes a secret, even one planted in the commit variable", async () => {
    // The commit variable is echoed only when it looks like a sha, so a
    // misconfigured value cannot become a channel for anything else.
    process.env.RAILWAY_GIT_COMMIT_SHA = INTERNAL_SECRET;
    process.env.RAILWAY_DEPLOYMENT_ID = INTERNAL_SECRET;
    const res = await getHealth(loadApp());

    expect(res.body.commit).toBe("unknown");
    expect(res.body.deploymentId).toBeNull();
    expect(res.raw).not.toContain(INTERNAL_SECRET);
    expect(res.raw).not.toContain("PRIVATE KEY");
    expect(Object.keys(res.body).sort()).toEqual(
      ["commit", "deploymentId", "redis", "service", "status", "ts", "version"],
    );
  });
});

describe("buildInfo", () => {
  it("lower-cases the sha so it compares equal to Railway's meta.commitHash", () => {
    expect(buildInfo({ RAILWAY_GIT_COMMIT_SHA: SHA.toUpperCase() }).commit).toBe(SHA);
  });

  it("reads nothing but the two named variables", () => {
    const info = buildInfo({
      RAILWAY_GIT_COMMIT_SHA: SHA,
      INTERNAL_SECRET,
      FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
    });
    expect(info).toEqual({ commit: SHA, version, deploymentId: null });
  });
});
