"use strict";
const crypto = require("crypto");
const http = require("http");

/* ------------------------------------------------------------------ */
/*  Mocks — must be set up BEFORE requiring the app                   */
/* ------------------------------------------------------------------ */

// Firestore mock
const _written = {};
const _added = [];
const mockDoc = (id) => ({
  set: jest.fn(async (data, opts) => {
    _written[id] = { data, opts };
  }),
});
const mockCollection = (name) => ({
  doc: (id) => mockDoc(`${name}/${id}`),
  add: jest.fn(async (data) => {
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

// Mock metamap-client
const mockGetVerificationResult = jest.fn().mockResolvedValue({
  status: "verified",
  identity: { status: "verified" },
  steps: [{ id: "document-reading", status: 200 }],
  documents: [{ type: "national-id", country: "MX" }],
  deviceFingerprint: null,
});

const realParseWebhook = require("./metamap-client").parseWebhook;

jest.mock("./metamap-client", () => ({
  parseWebhook: jest.fn(),
  getVerificationResult: mockGetVerificationResult,
}));

const metamapClient = require("./metamap-client");

/* ------------------------------------------------------------------ */
/*  Env setup                                                         */
/* ------------------------------------------------------------------ */
const WEBHOOK_SECRET = "test-webhook-secret-123";

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@test.iam.gserviceaccount.com",
});
process.env.REDIS_URL = "redis://localhost:6379";
process.env.METAMAP_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.INTERNAL_SECRET = "test-internal-secret";

/* ------------------------------------------------------------------ */
/*  Helper: HMAC sign a payload                                       */
/* ------------------------------------------------------------------ */
function sign(body, secret = WEBHOOK_SECRET) {
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(body))
    .digest("hex");
}

/* ------------------------------------------------------------------ */
/*  Helper: HTTP request against Express app                          */
/* ------------------------------------------------------------------ */
function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : "";
      const opts = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
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

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

let app;

beforeEach(() => {
  jest.clearAllMocks();
  // Clear written/added tracking
  Object.keys(_written).forEach((k) => delete _written[k]);
  _added.length = 0;

  // Clear require cache to get fresh app
  delete require.cache[require.resolve("../index")];
  app = require("../index");
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("vida-underwriting-service");
    expect(res.body.status).toBe("ok");
  });
});

describe("POST /webhooks/metamap", () => {
  it("returns 401 on invalid signature", async () => {
    metamapClient.parseWebhook.mockReturnValue({
      valid: false,
      eventName: "verification_completed",
      verificationId: "ver-123",
      step: undefined,
      metadata: {},
    });

    const body = { eventName: "verification_completed", resource: "ver-123" };
    const res = await request(app, "POST", "/webhooks/metamap", body, {
      "x-signature": "invalid-signature",
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid signature");
    expect(_added.length).toBe(1);
    expect(_added[0].collection).toBe("incident_log");
    expect(_added[0].data.source).toBe("metamap-webhook");
    expect(_added[0].data.error).toBe("invalid_signature");
  });

  it("returns 401 on missing x-signature header", async () => {
    metamapClient.parseWebhook.mockReturnValue({
      valid: false,
      eventName: "",
      verificationId: "",
      step: undefined,
      metadata: undefined,
    });

    const body = { eventName: "verification_completed" };
    const res = await request(app, "POST", "/webhooks/metamap", body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("returns 200 and logs verification_completed to shadow log", async () => {
    const body = {
      eventName: "verification_completed",
      resource: "ver-456",
      flowId: "flow-1",
      timestamp: "2026-03-21T12:00:00.000Z",
      metadata: { loanId: "loan-1", correlationId: "corr-1", stage: "4" },
    };

    metamapClient.parseWebhook.mockReturnValue({
      valid: true,
      eventName: "verification_completed",
      verificationId: "ver-456",
      step: undefined,
      metadata: body.metadata,
    });

    const res = await request(app, "POST", "/webhooks/metamap", body, {
      "x-signature": sign(body),
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Allow async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockGetVerificationResult).toHaveBeenCalledWith("ver-456");
  });

  it("returns 200 and merges step_completed into shadow log", async () => {
    const body = {
      eventName: "step_completed",
      step: { id: "document-reading", status: 200, data: { documentType: "national-id" }, error: null },
      resource: "ver-789",
      flowId: "flow-1",
      metadata: { loanId: "loan-2", correlationId: "corr-2" },
    };

    metamapClient.parseWebhook.mockReturnValue({
      valid: true,
      eventName: "step_completed",
      verificationId: "ver-789",
      step: body.step,
      metadata: body.metadata,
    });

    const res = await request(app, "POST", "/webhooks/metamap", body, {
      "x-signature": sign(body),
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));

    // getVerificationResult should NOT be called for step_completed
    expect(mockGetVerificationResult).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Contract: the REAL module vs what index.js assumes                */
/* ------------------------------------------------------------------ */
/**
 * Everything above this line runs against `jest.mock("./metamap-client")`.
 * That mock is why two production defects survived review: it declared
 * `getVerificationResult` and returned a `{ valid, ... }` envelope from
 * `parseWebhook`, while the real module after #346 exported neither. The
 * webhook suite was green against a contract the module had stopped honouring.
 *
 * These cases deliberately reach past the mock with `jest.requireActual` and
 * assert the real module still satisfies what index.js destructures. A mock is
 * a claim about a collaborator; this is the test that the claim is true.
 */
describe("metamap-client contract (real module, not the mock)", () => {
  const actual = jest.requireActual("./metamap-client");

  it("exports getVerificationResult — index.js:134 calls it on verification_completed", () => {
    // Absent after #346: every verification_completed webhook threw
    // "getVerificationResult is not a function", was swallowed by the handler's
    // catch, and landed in incident_log instead of metamap_shadow_log.
    expect(typeof actual.getVerificationResult).toBe("function");
  });

  it("parseWebhook returns the envelope index.js:115 destructures", () => {
    const body = { eventName: "verification_completed", resource: "v-123", metadata: { loanId: "L1" } };
    const secretBefore = process.env.METAMAP_WEBHOOK_SECRET;
    // Signed, because an unset secret is no longer a way to reach `valid: true`
    // — see the fail-closed note on parseWebhook. This case is about the
    // envelope's SHAPE on the accepting path, so it has to actually accept.
    process.env.METAMAP_WEBHOOK_SECRET = "envelope-shape-secret";
    try {
      const out = actual.parseWebhook(body, sign(body, "envelope-shape-secret"));
      // A bare parsed result (the old return) has none of these keys, so `valid`
      // read as undefined and every correctly-signed webhook took the 401 branch.
      expect(out).toHaveProperty("valid");
      expect(out).toHaveProperty("eventName", "verification_completed");
      expect(out).toHaveProperty("verificationId", "v-123");
      expect(out).toHaveProperty("metadata");
      expect(out.valid).toBe(true);
    } finally {
      if (secretBefore === undefined) delete process.env.METAMAP_WEBHOOK_SECRET;
      else process.env.METAMAP_WEBHOOK_SECRET = secretBefore;
    }
  });

  it("parseWebhook refuses to validate when METAMAP_WEBHOOK_SECRET is unset", () => {
    // RED before the fix: `valid` was initialised to true and only re-derived
    // inside `if (secret)`, so a missing variable accepted anything. See
    // src/webhook-metamap-unsigned.test.js for what that let a caller do.
    const body = { eventName: "verification_completed", resource: "v-123" };
    const secretBefore = process.env.METAMAP_WEBHOOK_SECRET;
    delete process.env.METAMAP_WEBHOOK_SECRET;
    try {
      expect(actual.parseWebhook(body, undefined).valid).toBe(false);
      expect(actual.parseWebhook(body, "any-signature-at-all").valid).toBe(false);
      expect(actual.parseWebhook(body, undefined).result).toBeNull();
    } finally {
      if (secretBefore === undefined) delete process.env.METAMAP_WEBHOOK_SECRET;
      else process.env.METAMAP_WEBHOOK_SECRET = secretBefore;
    }
  });

  it("parseWebhook returns valid:false on a bad signature instead of throwing", () => {
    // It used to throw. index.js has no try/catch around this call, so a bad
    // signature produced an unhandled rejection and no response at all — the
    // one case the 401 branch existed for was the one it never reached.
    const secretBefore = process.env.METAMAP_WEBHOOK_SECRET;
    process.env.METAMAP_WEBHOOK_SECRET = "a-secret";
    try {
      const body = { eventName: "verification_completed", resource: "v-123" };
      let out;
      expect(() => { out = actual.parseWebhook(body, "not-the-right-signature"); }).not.toThrow();
      expect(out.valid).toBe(false);
      expect(out.result).toBeNull();
    } finally {
      if (secretBefore === undefined) delete process.env.METAMAP_WEBHOOK_SECRET;
      else process.env.METAMAP_WEBHOOK_SECRET = secretBefore;
    }
  });

  it("parseWebhook survives a malformed body rather than throwing out of the handler", () => {
    const out = actual.parseWebhook("{not json", undefined);
    expect(out.valid).toBe(false);
  });
});
