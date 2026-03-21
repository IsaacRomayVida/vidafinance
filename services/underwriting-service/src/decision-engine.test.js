"use strict";

const APPLICANT = {
  rfc: "ROMA850101ABC",
  curp: "ROMA850101HDFRML09",
  firstName: "Juan",
  lastName: "Romero",
  email: "juan@example.com",
  phone: "+5215512345678",
  sessionKey: "session-ok",
  interviewId: "mock-interview-ROMA850101ABC",
  incodeToken: "mock-token",
};

const LOAN_ID = "loan-001";
const CORRELATION_ID = "corr-001";

// Stubs
let incodeResult, sardineResult, belvoResult, truoraCheckRef, truoraRaw, truoraParsed, metamapResult;
let metamapCalls, shadowLogs, warnLogs;

jest.mock("./incode-client", () => ({
  getScores: jest.fn(() => Promise.resolve(incodeResult)),
}));
jest.mock("./sardine-client", () => ({
  checkBehavioralRisk: jest.fn(() => Promise.resolve(sardineResult)),
}));
jest.mock("./belvo-client", () => ({
  getIMSSEmployment: jest.fn(() => Promise.resolve(belvoResult)),
}));
jest.mock("./truora-client", () => ({
  startCheck: jest.fn(() => Promise.resolve(truoraCheckRef)),
  pollCheck: jest.fn(() => Promise.resolve(truoraRaw)),
  parseResult: jest.fn(() => truoraParsed),
}));
jest.mock("./metamap-client", () => ({
  STAGE_4_MODULES: ["document-verification", "liveness", "facematch", "device-fingerprint"],
  STAGE_5_MODULES: ["aml-screening", "criminal-records", "pep-check"],
  createVerification: jest.fn((...args) => {
    metamapCalls.push(args);
    return Promise.resolve(metamapResult);
  }),
}));

const originalWarn = console.warn;
const originalLog = console.log;

beforeEach(() => {
  jest.clearAllMocks();
  metamapCalls = [];
  shadowLogs = [];
  warnLogs = [];

  // Default happy-path stubs
  incodeResult = { overall: "APPROVED", mocked: true };
  sardineResult = { pass: true, mocked: true };
  belvoResult = { records: [], provider: "belvo" };
  truoraCheckRef = { check_id: "chk-001", status: "pending" };
  truoraRaw = { check_id: "chk-001", status: "completed", criminal_record: false, pep: false, aml_watchlists: [] };
  truoraParsed = { pass: true, hard_reject: false, requires_human_review: false };
  metamapResult = { pass: true, mocked: true, verificationId: "mock-mm" };

  // Re-wire mock implementations after clearAllMocks
  incodeClient.getScores.mockImplementation(() => Promise.resolve(incodeResult));
  sardineClient.checkBehavioralRisk.mockImplementation(() => Promise.resolve(sardineResult));
  belvoClient.getIMSSEmployment.mockImplementation(() => Promise.resolve(belvoResult));
  truoraClient.startCheck.mockImplementation(() => Promise.resolve(truoraCheckRef));
  truoraClient.pollCheck.mockImplementation(() => Promise.resolve(truoraRaw));
  truoraClient.parseResult.mockImplementation(() => truoraParsed);
  metamapClient.createVerification.mockImplementation((...args) => {
    metamapCalls.push(args);
    return Promise.resolve(metamapResult);
  });

  // Capture logs
  console.log = jest.fn((...args) => {
    const msg = args[0];
    if (typeof msg === "string" && msg.includes("metamap_shadow_log")) {
      shadowLogs.push(JSON.parse(msg));
    }
  });
  console.warn = jest.fn((...args) => {
    warnLogs.push(args);
  });
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
  delete process.env.METAMAP_PRIMARY;
  delete process.env.METAMAP_MOCK;
  delete process.env.METAMAP_API_KEY;
});

const { runStage4, runStage5 } = require("./decision-engine");
const incodeClient = require("./incode-client");
const sardineClient = require("./sardine-client");
const belvoClient = require("./belvo-client");
const truoraClient = require("./truora-client");
const metamapClient = require("./metamap-client");

// --------------- METAMAP_PRIMARY=false (shadow mode) ---------------

describe("METAMAP_PRIMARY=false (shadow mode)", () => {
  beforeEach(() => {
    process.env.METAMAP_PRIMARY = "false";
    process.env.METAMAP_MOCK = "true";
  });

  describe("Stage 4", () => {
    it("uses legacy providers (Incode + Sardine) as authoritative", async () => {
      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.provider).toBe("legacy");
      expect(result.stage).toBe(4);
      expect(result.pass).toBe(true);
      expect(incodeClient.getScores).toHaveBeenCalled();
      expect(sardineClient.checkBehavioralRisk).toHaveBeenCalled();
    });

    it("always calls Belvo Open Banking", async () => {
      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      expect(belvoClient.getIMSSEmployment).toHaveBeenCalledWith(APPLICANT.curp);
    });

    it("fires MetaMap shadow call (does not block)", async () => {
      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      // Allow microtask queue to flush for fire-and-forget
      await new Promise(r => setTimeout(r, 50));

      expect(metamapCalls.length).toBe(1);
      expect(metamapCalls[0][1]).toEqual(metamapClient.STAGE_4_MODULES);
    });

    it("logs shadow result to metamap_shadow_log", async () => {
      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      await new Promise(r => setTimeout(r, 50));

      expect(shadowLogs.length).toBe(1);
      expect(shadowLogs[0].stage).toBe("stage4");
      expect(shadowLogs[0].loanId).toBe(LOAN_ID);
    });

    it("shadow errors do NOT affect primary decision", async () => {
      metamapClient.createVerification.mockImplementationOnce(() =>
        Promise.reject(new Error("MetaMap API down"))
      );

      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      await new Promise(r => setTimeout(r, 50));

      expect(result.pass).toBe(true);
      expect(result.provider).toBe("legacy");
    });

    it("returns pass=false when Incode declines", async () => {
      incodeResult = { overall: "DECLINED", mocked: true };
      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      expect(result.pass).toBe(false);
    });

    it("returns pass=false when Sardine flags high risk", async () => {
      sardineResult = { pass: false, risk_level: "very_high", mocked: true };
      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      expect(result.pass).toBe(false);
    });
  });

  describe("Stage 5", () => {
    it("uses Truora as authoritative", async () => {
      const result = await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.provider).toBe("legacy");
      expect(result.stage).toBe(5);
      expect(result.pass).toBe(true);
      expect(truoraClient.startCheck).toHaveBeenCalled();
      expect(truoraClient.pollCheck).toHaveBeenCalled();
    });

    it("fires MetaMap shadow call for Stage 5", async () => {
      await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);
      await new Promise(r => setTimeout(r, 50));

      expect(metamapCalls.length).toBe(1);
      expect(metamapCalls[0][1]).toEqual(metamapClient.STAGE_5_MODULES);
    });

    it("shadow errors do NOT affect primary Stage 5 decision", async () => {
      metamapClient.createVerification.mockImplementationOnce(() =>
        Promise.reject(new Error("MetaMap timeout"))
      );

      const result = await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);
      await new Promise(r => setTimeout(r, 50));

      expect(result.pass).toBe(true);
      expect(result.provider).toBe("legacy");
    });
  });

  describe("no MetaMap credentials", () => {
    it("skips shadow call when METAMAP_MOCK=false and no API key", async () => {
      process.env.METAMAP_MOCK = "false";
      delete process.env.METAMAP_API_KEY;

      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      await new Promise(r => setTimeout(r, 50));

      expect(metamapCalls.length).toBe(0);
    });
  });
});

// --------------- METAMAP_PRIMARY=true ---------------

describe("METAMAP_PRIMARY=true", () => {
  beforeEach(() => {
    process.env.METAMAP_PRIMARY = "true";
    process.env.METAMAP_MOCK = "true";
  });

  describe("Stage 4", () => {
    it("uses MetaMap as authoritative provider", async () => {
      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.provider).toBe("metamap");
      expect(result.stage).toBe(4);
      expect(result.pass).toBe(true);
      expect(metamapCalls.length).toBe(1);
    });

    it("does NOT call Incode or Sardine", async () => {
      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(incodeClient.getScores).not.toHaveBeenCalled();
      expect(sardineClient.checkBehavioralRisk).not.toHaveBeenCalled();
    });

    it("always calls Belvo Open Banking", async () => {
      await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      expect(belvoClient.getIMSSEmployment).toHaveBeenCalledWith(APPLICANT.curp);
    });

    it("returns pass=false when MetaMap fails verification", async () => {
      metamapResult = { pass: false, mocked: true };
      const result = await runStage4(APPLICANT, LOAN_ID, CORRELATION_ID);
      expect(result.pass).toBe(false);
    });
  });

  describe("Stage 5", () => {
    it("uses MetaMap as authoritative provider", async () => {
      const result = await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.provider).toBe("metamap");
      expect(result.stage).toBe(5);
      expect(result.pass).toBe(true);
    });

    it("does NOT call Truora", async () => {
      await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(truoraClient.startCheck).not.toHaveBeenCalled();
      expect(truoraClient.pollCheck).not.toHaveBeenCalled();
    });

    it("returns hard_reject when MetaMap flags it", async () => {
      metamapResult = { pass: false, hard_reject: true, mocked: true };
      const result = await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.pass).toBe(false);
      expect(result.hard_reject).toBe(true);
    });

    it("returns requires_human_review when MetaMap flags it", async () => {
      metamapResult = { pass: false, requires_human_review: true, mocked: true };
      const result = await runStage5(APPLICANT, LOAN_ID, CORRELATION_ID);

      expect(result.requires_human_review).toBe(true);
    });
  });
});
