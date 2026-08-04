"use strict";
/**
 * POST /webhooks/metamap must reject unsigned payloads even when
 * METAMAP_WEBHOOK_SECRET is not configured.
 *
 * Unlike src/webhook-metamap.test.js, this suite does NOT mock
 * ./metamap-client -- it exercises the real parseWebhook, because the defect
 * under test lives in that function's signature-verification default and a
 * mocked client cannot show it.
 *
 * The defect: parseWebhook initialised `valid = true` and only re-derived it
 * inside `if (secret)`. With METAMAP_WEBHOOK_SECRET unset -- which is exactly
 * how services/underwriting-service/.env.example ships it, and there is no boot
 * guard for it -- every request to this route was accepted with no signature at
 * all. An anonymous caller could:
 *   - write attacker-chosen documents into metamap_shadow_log under an
 *     attacker-chosen verificationId, with attacker-chosen loanId /
 *     correlationId / step payloads, and overwrite (set(), no merge) an
 *     existing legitimate shadow-log entry for a known verification;
 *   - drive metamapClient.getVerificationResult(verificationId) -- an
 *     outbound, credential-bearing call into our MetaMap tenant with an
 *     attacker-supplied id -- once per request, unbounded.
 *
 * The two `secret unset` tests below FAIL before the fix (they get 200 and a
 * shadow-log write) and pass after it. The two `secret configured` tests are
 * CONTROLS: they pass both before and after, and pin that a correctly signed
 * webhook still reaches the shadow log with the same 200 / {received:true}
 * response it always had.
 */
const crypto = require("crypto");
const http = require("http");

/* ------------------------------------------------------------------ */
/*  Mocks — must be set up BEFORE requiring the app                   */
/* ------------------------------------------------------------------ */

const _written = [];
const _added = [];

const mockFirestore = () => ({
  collection: jest.fn((name) => ({
    doc: (id) => ({
      set: jest.fn(async (data, opts) => {
        _written.push({ collection: name, id, data, opts });
      }),
    }),
    add: jest.fn(async (data) => {
      _added.push({ collection: name, data });
      return { id: "mock-id" };
    }),
  })),
});
mockFirestore.FieldValue = { serverTimestamp: () => "SERVER_TIMESTAMP" };

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(mockFirestore, {
    FieldValue: mockFirestore.FieldValue,
  }),
}));

jest.mock("ioredis", () =>
  jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue("PONG"),
    disconnect: jest.fn(),
    on: jest.fn(),
  })),
);

/* ------------------------------------------------------------------ */
/*  Env setup                                                         */
/* ------------------------------------------------------------------ */
const WEBHOOK_SECRET = "unsigned-suite-secret";

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: "test",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@test.iam.gserviceaccount.com",
});
process.env.REDIS_URL = "redis://localhost:6379";
process.env.INTERNAL_SECRET = "test-internal-secret";
// Keeps the real metamap-client's getVerificationResult off the network on the
// happy path -- the point of this suite is the signature gate, not the fetch.
process.env.METAMAP_MOCK = "true";

function sign(body, secret) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");
}

function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers: { "Content-Type": "application/json", ...headers },
        },
        (res) => {
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
        },
      );
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
const SECRET_BEFORE = process.env.METAMAP_WEBHOOK_SECRET;

function loadApp() {
  delete require.cache[require.resolve("../index")];
  return require("../index");
}

beforeEach(() => {
  jest.clearAllMocks();
  _written.length = 0;
  _added.length = 0;
});

afterAll(() => {
  if (SECRET_BEFORE === undefined) delete process.env.METAMAP_WEBHOOK_SECRET;
  else process.env.METAMAP_WEBHOOK_SECRET = SECRET_BEFORE;
});

const BODY = {
  eventName: "verification_completed",
  resource: "attacker-chosen-verification-id",
  metadata: { loanId: "loan-under-attack", correlationId: "corr-x" },
};

describe("POST /webhooks/metamap with METAMAP_WEBHOOK_SECRET unset", () => {
  beforeEach(() => {
    delete process.env.METAMAP_WEBHOOK_SECRET;
    app = loadApp();
  });

  // RED before the fix: answered 200 {received:true}.
  it("rejects a payload carrying no signature at all", async () => {
    const res = await request(app, "POST", "/webhooks/metamap", BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid signature");
  });

  // RED before the fix: the unsigned payload reached metamap_shadow_log.
  it("writes nothing to metamap_shadow_log for an unsigned payload", async () => {
    await request(app, "POST", "/webhooks/metamap", BODY);
    // The handler answers first and processes after, so give the async tail the
    // same window the accepted-payload control below gets.
    await new Promise((r) => setTimeout(r, 50));

    expect(_written).toHaveLength(0);
    expect(_added.map((a) => a.collection)).toEqual(["incident_log"]);
    expect(_added[0].data.error).toBe("invalid_signature");
  });
});

describe("POST /webhooks/metamap with METAMAP_WEBHOOK_SECRET configured", () => {
  beforeEach(() => {
    process.env.METAMAP_WEBHOOK_SECRET = WEBHOOK_SECRET;
    app = loadApp();
  });

  // CONTROL — passes before and after the fix.
  it("still accepts a correctly signed payload and shadow-logs it", async () => {
    const res = await request(app, "POST", "/webhooks/metamap", BODY, {
      "x-signature": sign(BODY, WEBHOOK_SECRET),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(_written).toHaveLength(1);
    expect(_written[0].collection).toBe("metamap_shadow_log");
    expect(_written[0].id).toBe(BODY.resource);
    expect(_written[0].data.loanId).toBe("loan-under-attack");
  });

  // CONTROL — passes before and after the fix.
  it("still rejects a payload signed with the wrong key", async () => {
    const res = await request(app, "POST", "/webhooks/metamap", BODY, {
      "x-signature": sign(BODY, "not-the-configured-secret"),
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid signature");
    await new Promise((r) => setTimeout(r, 50));
    expect(_written).toHaveLength(0);
  });
});
