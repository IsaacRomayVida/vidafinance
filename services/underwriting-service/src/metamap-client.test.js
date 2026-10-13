"use strict";
/**
 * metamap-client — the real module, against a stubbed node-fetch.
 *
 * Ported from tests/metamap-client.test.js, which never ran (jest `roots` is
 * src/) and had drifted to an API this module no longer has: getToken,
 * parseDeviceSignals, _resetTokenCache, a string flowType. Every other suite
 * that touches MetaMap mocks this module wholesale, so OAuth caching, the
 * retry loop, the REST result parsers and the mock-mode seeds had no test.
 * parseWebhook is not repeated here; the contract block at the bottom of
 * webhook-metamap.test.js covers it against the real module.
 */

const fetch = require("node-fetch");
const client = require("./metamap-client");

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

const ENV_KEYS = [
  "METAMAP_MOCK", "METAMAP_CLIENT_ID", "METAMAP_CLIENT_SECRET",
  "METAMAP_BASE_URL", "METAMAP_FLOW_ID_KYC", "METAMAP_FLOW_ID_AML",
];
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

const APPLICANT = {
  firstName: "Juan", lastName: "Garcia", curp: "GARA900101HDFRRL09",
  rfc: "GARA900101ABC", email: "test@example.com", dateOfBirth: "1990-01-01",
};

beforeEach(() => {
  fetch.mockReset();
  client.__resetForTests();
  process.env.METAMAP_MOCK = "false";
  process.env.METAMAP_CLIENT_ID = "test-client-id";
  process.env.METAMAP_CLIENT_SECRET = "test-client-secret";
  process.env.METAMAP_BASE_URL = "https://api.getmati.com";
  process.env.METAMAP_FLOW_ID_KYC = "flow-kyc-123";
  process.env.METAMAP_FLOW_ID_AML = "flow-aml-456";
});

describe("getAccessToken", () => {
  it("authenticates with client_credentials over Basic auth", async () => {
    fetch.mockResolvedValueOnce(jsonRes({ access_token: "jwt-abc", expiresIn: 3600 }));

    expect(await client.getAccessToken()).toBe("jwt-abc");
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("https://api.getmati.com/oauth");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe("grant_type=client_credentials");
    const basic = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(opts.headers.Authorization).toBe(`Basic ${basic}`);
  });

  it("reuses a cached token", async () => {
    fetch.mockResolvedValueOnce(jsonRes({ access_token: "jwt-abc", expiresIn: 3600 }));

    await client.getAccessToken();
    expect(await client.getAccessToken()).toBe("jwt-abc");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token inside the 60s pre-expiry window", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt-old", expiresIn: 1 }))
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt-new", expiresIn: 3600 }));

    await client.getAccessToken();
    expect(await client.getAccessToken()).toBe("jwt-new");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws on an auth failure", async () => {
    fetch.mockResolvedValueOnce(textRes("Unauthorized", 401));

    await expect(client.getAccessToken()).rejects.toThrow("MetaMap OAuth 401");
  });
});

describe("createVerification", () => {
  it("starts the KYC flow for STAGE_4_MODULES with a Bearer token", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({ id: "ver-123", flowRunUrl: "https://signup.getmati.com/?t=abc" }));

    const out = await client.createVerification(APPLICANT, client.STAGE_4_MODULES);
    expect(out).toEqual({ verificationId: "ver-123", flowRunUrl: "https://signup.getmati.com/?t=abc" });

    const [url, opts] = fetch.mock.calls[1];
    expect(url).toBe("https://api.getmati.com/v2/verifications");
    expect(opts.headers.Authorization).toBe("Bearer jwt");
    const body = JSON.parse(opts.body);
    expect(body.flowId).toBe("flow-kyc-123");
    expect(body.metadata.curp).toBe(APPLICANT.curp);
  });

  it("starts the AML flow for STAGE_5_MODULES", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({ _id: "ver-aml" }));

    const out = await client.createVerification(APPLICANT, client.STAGE_5_MODULES);
    expect(out).toEqual({ verificationId: "ver-aml", flowRunUrl: null });
    expect(JSON.parse(fetch.mock.calls[1][1].body).flowId).toBe("flow-aml-456");
  });

  it("retries a transient failure", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(textRes("server error", 500))
      .mockResolvedValueOnce(jsonRes({ id: "ver-retry" }));

    const out = await client.createVerification(APPLICANT, client.STAGE_4_MODULES);
    expect(out.verificationId).toBe("ver-retry");
    // 1 auth (cached for the retry) + 2 verification attempts
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("throws once all 3 attempts are exhausted", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValue(textRes("server error", 500));

    await expect(client.createVerification(APPLICANT, client.STAGE_4_MODULES))
      .rejects.toThrow("MetaMap createVerification 500");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("getVerificationResult (live)", () => {
  it("fetches once and parses a KYC verification", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({
        id: "ver-123",
        status: "completed",
        steps: [
          { id: "document-verification", status: "completed", data: {} },
          { id: "facematch", status: "completed", data: { matchScore: 0.79 } },
          { id: "liveness", status: "completed", data: { isAlive: true } },
          { id: "device-fingerprint", status: "completed", data: { isEmulator: true, deviceAgeDays: 30 } },
          { id: "behavioral-analysis", status: "completed", data: { anomalyDetected: true, anomalyScore: 0.7 } },
          { id: "government-check", status: "completed", data: { valid: false } },
        ],
      }));

    const out = await client.getVerificationResult("ver-123");
    expect(fetch.mock.calls[1][0]).toBe("https://api.getmati.com/v2/verifications/ver-123");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.verificationId).toBe("ver-123");
    expect(out.documentVerification.passed).toBe(true);
    // 0.80 is the facematch floor
    expect(out.facematch).toEqual({ passed: false, score: 0.79 });
    expect(out.liveness.passed).toBe(true);
    expect(out.deviceFingerprint.emulator_detected).toBe(1);
    expect(out.deviceFingerprint.device_age_days).toBe(30);
    expect(out.behavioralAnalysis).toEqual({ passed: false, anomalyScore: 0.7 });
    expect(out.governmentCheck.passed).toBe(false);
  });

  it("parses an AML verification when isAML is set", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonRes({
        id: "ver-aml",
        steps: [
          { id: "aml-screening", data: { hits: [{ listName: "OFAC", matchType: "CONFIRMED" }] } },
          { id: "pep-check", data: { isPEP: false } },
        ],
      }));

    const out = await client.getVerificationResult("ver-aml", "", { isAML: true });
    expect(out.status).toBe("flagged");
    expect(out.amlScreening).toEqual({ hit: true, lists: [{ list: "OFAC", matchType: "CONFIRMED" }] });
    expect(out.criminalRecords.found).toBe(false);
  });

  it("throws on a non-2xx response", async () => {
    fetch
      .mockResolvedValueOnce(jsonRes({ access_token: "jwt", expiresIn: 3600 }))
      .mockResolvedValueOnce(textRes("not found", 404));

    await expect(client.getVerificationResult("ver-x")).rejects.toThrow("MetaMap 404");
  });
});

describe("parseAMLResult", () => {
  it("is clear with no hits, records or PEP", () => {
    expect(client.parseAMLResult({ id: "v", steps: [] }).status).toBe("clear");
  });

  it("flags a PEP on its own", () => {
    const out = client.parseAMLResult({
      id: "v", steps: [{ id: "pep-check", data: { isPEP: true, position: "Senador" } }],
    });
    expect(out.status).toBe("flagged");
    expect(out.pepCheck).toEqual({ isPEP: true, position: "Senador" });
  });
});

describe("extractDeviceSignals", () => {
  it("maps exactly the 7 model features", () => {
    const out = client.extractDeviceSignals({
      isEmulator: true, isVPN: false, isRooted: true, deviceAgeDays: 30,
      ipReputationScore: 0.7, sessionDuration: 120, interactionAnomalyScore: 0.3,
    });
    expect(out).toEqual({
      emulator_detected: 1, vpn_detected: 0, rooted_device: 1, device_age_days: 30,
      ip_reputation_score: 0.7, session_duration_seconds: 120, interaction_anomaly_score: 0.3,
    });
  });

  it("defaults every feature to 0 when the device step is empty", () => {
    const out = client.extractDeviceSignals({});
    expect(Object.keys(out)).toHaveLength(7);
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
  });
});

describe("mock mode", () => {
  beforeEach(() => {
    process.env.METAMAP_MOCK = "true";
  });

  it("returns seeded verification ids without calling fetch", async () => {
    expect(await client.createVerification({ rfc: "ABC123CLEAN" }, client.STAGE_4_MODULES))
      .toEqual({ verificationId: "mock-kyc-ABC123CLEAN", flowRunUrl: null });
    expect(await client.createVerification({ rfc: "ABC123CLEAN" }, client.STAGE_5_MODULES))
      .toEqual({ verificationId: "mock-aml-ABC123CLEAN", flowRunUrl: null });
    await client.getVerificationResult("v", "ABC123CLEAN");
    await client.pollVerification("v", "ABC123CLEAN");
    await client.checkBehavioralRisk("s", "u");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("seeds KYC outcomes from the RFC suffix", async () => {
    const clean = await client.getVerificationResult("v", "ABC123CLEAN");
    expect(clean.status).toBe("verified");
    expect(clean.mocked).toBe(true);

    const fake = await client.getVerificationResult("v", "DOCFAKEXXX");
    expect(fake.status).toBe("rejected");
    expect(fake.documentVerification.reason).toBe("DOCUMENT_ALTERED");

    const device = await client.getVerificationResult("v", "DEVICEZZZ");
    expect(device.status).toBe("reviewNeeded");
    expect(device.deviceFingerprint).toMatchObject({
      emulator_detected: 1, vpn_detected: 1, rooted_device: 1, interaction_anomaly_score: 0.92,
    });
  });

  it("seeds AML outcomes from the RFC suffix", async () => {
    const aml = (rfc) => client.getVerificationResult("v", rfc, { isAML: true });
    expect((await aml("ABC123CLEAN")).status).toBe("clear");

    const confirmed = await aml("AMLHITXXX");
    expect(confirmed.amlScreening.lists[0].matchType).toBe("CONFIRMED");
    expect(confirmed.criminalRecords.found).toBe(true);

    const fuzzy = await aml("AMLHITYYY");
    expect(fuzzy.amlScreening.lists[0].matchType).toBe("FUZZY");
    expect(fuzzy.pepCheck.isPEP).toBe(true);
  });
});
