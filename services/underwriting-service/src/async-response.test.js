"use strict";
/**
 * async-response.test.js
 *
 * Express 4 does not catch a rejected promise from an async route handler --
 * when one rejects, the request gets no response at all and the caller hangs
 * until its own timeout. Same defect class as the registry-service transaction
 * fix (#524) and the payment-server webhook fix (#526). This file covers the
 * two shapes of it found in this service:
 *
 *   - GET /metrics: `res.end(await metricsRegister.metrics())` has no
 *     try/catch at all.
 *   - POST /webhooks/metamap: the invalid-signature branch awaits
 *     `db.collection('incident_log').add(...)` before `return
 *     res.status(401)`, with no try/catch around it.
 *
 * No supertest dependency in this package (see package.json) -- `request()`
 * below is the same raw-http-against-a-live-listener helper webhook-metamap.test.js
 * uses, extended with an explicit socket timeout so a hang surfaces as a timeout
 * error rather than blocking the suite forever.
 */

const crypto = require("crypto");
const http = require("http");

/* ------------------------------------------------------------------ */
/*  Mocks — must be set up BEFORE requiring the app                   */
/* ------------------------------------------------------------------ */

const _added = [];
let _incidentLogShouldReject = false;

const mockDoc = () => ({
  set: jest.fn(async () => {}),
});
const mockCollection = (name) => ({
  doc: () => mockDoc(),
  add: jest.fn(async (data) => {
    if (name === "incident_log" && _incidentLogShouldReject) {
      throw new Error("Firestore unavailable");
    }
    _added.push({ collection: name, data });
    return { id: "mock-id" };
  }),
});

const mockFirestore = () => ({
  collection: jest.fn((name) => mockCollection(name)),
});
mockFirestore.FieldValue = {
  serverTimestamp: () => "SERVER_TIMESTAMP",
};

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(mockFirestore, {
    FieldValue: mockFirestore.FieldValue,
  }),
}));

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue("PONG"),
    disconnect: jest.fn(),
    on: jest.fn(),
  }));
});

jest.mock("./metamap-client", () => ({
  parseWebhook: jest.fn(),
  getVerificationResult: jest.fn(),
}));

const metamapClient = require("./metamap-client");

/* ------------------------------------------------------------------ */
/*  Env setup                                                         */
/* ------------------------------------------------------------------ */

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@test.iam.gserviceaccount.com",
});
process.env.REDIS_URL = "redis://localhost:6379";
process.env.METAMAP_WEBHOOK_SECRET = "test-webhook-secret-123";
process.env.INTERNAL_SECRET = "test-internal-secret";

/* ------------------------------------------------------------------ */
/*  Helper: HTTP request against the Express app with a hard timeout  */
/* ------------------------------------------------------------------ */
// Resolves { status, body, timedOut: false } on a real response, or
// { timedOut: true } if the server takes longer than timeoutMs -- this is
// what makes a hang show up as discriminating evidence instead of the test
// simply blocking forever.
function request(app, method, path, body, headers = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : "";
      const opts = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json", ...headers },
        timeout: timeoutMs,
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data), timedOut: false });
          } catch {
            resolve({ status: res.statusCode, body: data, timedOut: false });
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        server.close();
        resolve({ timedOut: true });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  _added.length = 0;
  _incidentLogShouldReject = false;

  delete require.cache[require.resolve("../index")];
  app = require("../index");
});

describe("GET /metrics", () => {
  test("returns the Prometheus text body on the healthy path (control)", async () => {
    const res = await request(app, "GET", "/metrics");
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(200);
  });

  test("returns 500 instead of hanging when the collector rejects", async () => {
    const { register: metricsRegister } = require("../../shared/metrics");
    const spy = jest
      .spyOn(metricsRegister, "metrics")
      .mockRejectedValueOnce(new Error("collector exploded"));
    try {
      const res = await request(app, "GET", "/metrics");
      expect(res.timedOut).toBe(false);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /webhooks/metamap — invalid signature path", () => {
  function signBody() {
    metamapClient.parseWebhook.mockReturnValue({
      valid: false,
      eventName: "verification_completed",
      verificationId: "ver-123",
      step: undefined,
      metadata: {},
    });
    return { eventName: "verification_completed", resource: "ver-123" };
  }

  test("returns 401 when the incident_log write succeeds (control)", async () => {
    const body = signBody();
    const res = await request(app, "POST", "/webhooks/metamap", body, {
      "x-signature": "invalid-signature",
    });
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(401);
  });

  test("still returns 401 instead of hanging when the incident_log write rejects", async () => {
    _incidentLogShouldReject = true;
    const body = signBody();
    const res = await request(app, "POST", "/webhooks/metamap", body, {
      "x-signature": "invalid-signature",
    });
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(401);
  });
});
