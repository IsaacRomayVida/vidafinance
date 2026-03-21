"use strict";

const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/*  Mock node-fetch                                                   */
/* ------------------------------------------------------------------ */
const mockFetch = jest.fn();
jest.mock("node-fetch", () => mockFetch);

const {
  getToken,
  createVerification,
  getVerificationResult,
  parseWebhook,
  parseDeviceSignals,
  _resetTokenCache,
} = require("../src/metamap-client");

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textRes(text, status) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error("not json"); },
    text: async () => text,
  };
}

const WEBHOOK_SECRET = "test-webhook-secret";

/* ------------------------------------------------------------------ */
/*  Setup / Teardown                                                  */
/* ------------------------------------------------------------------ */
beforeEach(() => {
  jest.clearAllMocks();
  _resetTokenCache();

  process.env.METAMAP_MOCK = "false";
  process.env.METAMAP_CLIENT_ID = "test-client-id";
  process.env.METAMAP_CLIENT_SECRET = "test-client-secret";
  process.env.METAMAP_BASE_URL = "https://api.getmati.com";
  process.env.METAMAP_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.METAMAP_FLOW_ID_KYC = "flow-kyc-123";
  process.env.METAMAP_FLOW_ID_AML = "flow-aml-456";
});

/* ================================================================== */
/*  getToken                                                          */
/* ================================================================== */
describe("getToken", () => {
  it("authenticates and returns access_token", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ access_token: "jwt-abc", expiresIn: 3600 }));

    const token = await getToken();
    expect(token).toBe("jwt-abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.getmati.com/oauth",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
      }),
    );
    // Basic auth header
    const call = mockFetch.mock.calls[0][1];
    const expected = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(call.headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("caches token on subsequent calls", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ access_token: "jwt-abc", expiresIn: 3600 }));

    await getToken();
    const token2 = await getToken();
    expect(token2).toBe("jwt-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes token when expired", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt-old", expiresIn: 1 })) // expires in 1s, refresh 60s before → already stale
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt-new", expiresIn: 3600 }));

    await getToken();
    const token2 = await getToken();
    expect(token2).toBe("jwt-new");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on auth failure", async () => {
    mockFetch.mockResolvedValueOnce(textRes("Unauthorized", 401));

    await expect(getToken()).rejects.toThrow("MetaMap auth 401");
  });
});

/* ================================================================== */
/*  createVerification                                                */
/* ================================================================== */
describe("createVerification", () => {
  const applicant = {
    curp: "CURP123",
    rfc: "RFC456CLEAN",
    name: "Test User",
    email: "test@example.com",
    phone: "+5215500000000",
    loanId: "loan-abc",
    correlationId: "corr-xyz",
  };

  it("creates a KYC verification", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({
        id: "ver-123", identity: "id-456",
        url: "https://signup.getmati.com/?merchantToken=abc", status: "pending",
      }));

    const result = await createVerification(applicant, "kyc");
    expect(result).toEqual({
      verificationId: "ver-123",
      identityId: "id-456",
      verificationUrl: "https://signup.getmati.com/?merchantToken=abc",
      status: "pending",
    });

    // Second call should be the verification POST
    const verCall = mockFetch.mock.calls[1];
    expect(verCall[0]).toBe("https://api.getmati.com/v2/verifications");
    const body = JSON.parse(verCall[1].body);
    expect(body.flowId).toBe("flow-kyc-123");
    expect(body.metadata.stage).toBe("4");
  });

  it("uses AML flow when flowType is 'aml'", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({
        id: "ver-aml", identity: "id-aml", url: "https://signup.getmati.com/?t=aml", status: "pending",
      }));

    await createVerification(applicant, "aml");
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.flowId).toBe("flow-aml-456");
    expect(body.metadata.stage).toBe("5");
  });

  it("retries on transient failure", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(textRes("server error", 500))
      .mockResolvedValueOnce(jsonRes({
        id: "ver-retry", identity: "id-retry", url: "https://signup.getmati.com/?t=r", status: "pending",
      }));

    const result = await createVerification(applicant, "kyc");
    expect(result.verificationId).toBe("ver-retry");
    // 1 auth + 2 verification attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries exhausted", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValue(textRes("server error", 500));

    await expect(createVerification(applicant, "kyc")).rejects.toThrow("MetaMap 500");
  });
});

/* ================================================================== */
/*  getVerificationResult                                             */
/* ================================================================== */
describe("getVerificationResult", () => {
  it("returns full verification data", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({
        status: "verified",
        identity: { status: "verified" },
        steps: [{ id: "document-reading", status: 200 }],
        documents: [{ type: "national-id" }],
        deviceFingerprint: { emulator: false },
      }));

    const result = await getVerificationResult("ver-123");
    expect(result.status).toBe("verified");
    expect(result.steps).toHaveLength(1);
    expect(result.documents).toHaveLength(1);
    expect(result.deviceFingerprint).toEqual({ emulator: false });
  });

  it("handles all MetaMap statuses", async () => {
    for (const status of ["verified", "reviewNeeded", "rejected", "pending"]) {
      _resetTokenCache();
      jest.clearAllMocks();
      mockFetch
        .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
        .mockResolvedValueOnce(jsonRes({ status, identity: {}, steps: [], documents: [] }));

      const result = await getVerificationResult("ver-x");
      expect(result.status).toBe(status);
    }
  });
});

/* ================================================================== */
/*  parseWebhook                                                      */
/* ================================================================== */
describe("parseWebhook", () => {
  it("validates correct HMAC signature", () => {
    const payload = { eventName: "verification_completed", resource: "ver-123", metadata: { loanId: "loan-1" } };
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

    const result = parseWebhook(payload, sig);
    expect(result.valid).toBe(true);
    expect(result.eventName).toBe("verification_completed");
    expect(result.verificationId).toBe("ver-123");
    expect(result.metadata).toEqual({ loanId: "loan-1" });
  });

  it("rejects invalid signature", () => {
    const payload = { eventName: "verification_completed", resource: "ver-123" };
    const result = parseWebhook(payload, "bad-signature");
    expect(result.valid).toBe(false);
  });

  it("handles string payload", () => {
    const payloadObj = { eventName: "step_completed", resource: "ver-456", step: { id: "liveness" } };
    const body = JSON.stringify(payloadObj);
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

    const result = parseWebhook(body, sig);
    expect(result.valid).toBe(true);
    expect(result.eventName).toBe("step_completed");
    expect(result.step).toEqual({ id: "liveness" });
  });

  it("handles signature length mismatch gracefully", () => {
    const payload = { eventName: "verification_completed", resource: "ver-123" };
    const result = parseWebhook(payload, "short");
    expect(result.valid).toBe(false);
  });
});

/* ================================================================== */
/*  parseDeviceSignals                                                */
/* ================================================================== */
describe("parseDeviceSignals", () => {
  it("extracts exactly 7 numeric features", () => {
    const result = parseDeviceSignals({
      deviceFingerprint: {
        emulator: true, vpn: false, rooted: true,
        deviceAgeDays: 30, ipReputationScore: 0.7,
        sessionDurationSeconds: 120, interactionAnomalyScore: 0.3,
      },
    });

    expect(Object.keys(result)).toHaveLength(7);
    expect(result).toEqual({
      emulator_detected: 1,
      vpn_detected: 0,
      rooted_device: 1,
      device_age_days: 30,
      ip_reputation_score: 0.7,
      session_duration_seconds: 120,
      interaction_anomaly_score: 0.3,
    });
  });

  it("returns safe defaults when deviceFingerprint is missing", () => {
    const result = parseDeviceSignals({});
    expect(Object.keys(result)).toHaveLength(7);
    expect(result.emulator_detected).toBe(0);
    expect(result.device_age_days).toBe(-1);
  });
});

/* ================================================================== */
/*  Mock mode                                                         */
/* ================================================================== */
describe("mock mode", () => {
  beforeEach(() => {
    process.env.METAMAP_MOCK = "true";
  });

  describe("createVerification", () => {
    it("returns verified for clean RFC", async () => {
      const result = await createVerification({ rfc: "ABC123CLEAN", loanId: "l", correlationId: "c" }, "kyc");
      expect(result.status).toBe("verified");
      expect(result.mocked).toBe(true);
      expect(result.verificationId).toBeTruthy();
      expect(result.verificationUrl).toBeTruthy();
    });

    it("returns rejected for RFC ending XXX (fake doc)", async () => {
      const result = await createVerification({ rfc: "DOCFAKEXXX", loanId: "l", correlationId: "c" }, "kyc");
      expect(result.status).toBe("rejected");
      expect(result.mocked).toBe(true);
    });

    it("returns reviewNeeded for RFC ending YYY (AML hit)", async () => {
      const result = await createVerification({ rfc: "AMLHITYYY", loanId: "l", correlationId: "c" }, "aml");
      expect(result.status).toBe("reviewNeeded");
      expect(result.mocked).toBe(true);
    });
  });

  describe("getVerificationResult", () => {
    it("returns verified with clean device signals for default RFC", async () => {
      const result = await getVerificationResult("mock-ver", "ABC123CLEAN");
      expect(result.status).toBe("verified");
      expect(result.steps).toBeInstanceOf(Array);
      expect(result.documents).toBeInstanceOf(Array);
      expect(result.deviceFingerprint.emulator).toBe(false);
      expect(result.mocked).toBe(true);
    });

    it("returns rejected with emulator for ZZZ RFC (device fraud)", async () => {
      const result = await getVerificationResult("mock-ver", "DEVICEZZZ");
      expect(result.status).toBe("rejected");
      expect(result.deviceFingerprint.emulator).toBe(true);
      expect(result.deviceFingerprint.vpn).toBe(true);
      expect(result.deviceFingerprint.rooted).toBe(true);
    });

    it("returns reviewNeeded with AML watchlist hit for YYY RFC", async () => {
      const result = await getVerificationResult("mock-ver", "AMLHITYYY");
      expect(result.status).toBe("reviewNeeded");
      const watchlistStep = result.steps.find((s) => s.id === "watchlist");
      expect(watchlistStep).toBeTruthy();
      expect(watchlistStep.data.hits).toBe(1);
    });

    it("returns rejected with alteration for XXX RFC", async () => {
      const result = await getVerificationResult("mock-ver", "DOCFAKEXXX");
      expect(result.status).toBe("rejected");
      const alterStep = result.steps.find((s) => s.id === "alteration-detection");
      expect(alterStep.data.detected).toBe(true);
    });

    it("mock results feed correctly into parseDeviceSignals", async () => {
      const verResult = await getVerificationResult("mock-ver", "DEVICEZZZ");
      const signals = parseDeviceSignals(verResult);
      expect(signals.emulator_detected).toBe(1);
      expect(signals.vpn_detected).toBe(1);
      expect(signals.rooted_device).toBe(1);
      expect(signals.interaction_anomaly_score).toBe(0.97);
    });
  });

  it("does not call fetch in mock mode", async () => {
    await createVerification({ rfc: "TEST123", loanId: "l", correlationId: "c" }, "kyc");
    await getVerificationResult("v", "TEST123");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
