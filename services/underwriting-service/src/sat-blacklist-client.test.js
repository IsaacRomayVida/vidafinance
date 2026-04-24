"use strict";
/**
 * Tests for sat-blacklist-client — verifies:
 *   - GCS read happens exactly once across many concurrent calls
 *   - return shapes match sw-client exactly (drop-in compatibility)
 *   - DEFINITIVO / PRESUNTO / clean branches
 *   - Art. 69 hit vs clean
 *   - missing FIREBASE_STORAGE_BUCKET throws
 *   - GCS download errors propagate (→ employer-a escalation)
 */

jest.mock("./redis-client", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
}));

const mockDownload = jest.fn();
const mockFile = jest.fn((_path) => ({ download: mockDownload }));
const mockBucket = jest.fn((_name) => ({ file: mockFile }));

jest.mock("firebase-admin", () => ({
  storage: jest.fn(() => ({ bucket: mockBucket })),
}));

const client = require("./sat-blacklist-client");

const EFOS_BLOB = {
  generatedAt: "2026-04-15T02:00:00.000Z",
  source: "http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv",
  rows: {
    DEFAULT_RFC: { rfc: "DEFAULT_RFC", nombre: "Default", situacion: "DEFINITIVO" },
    PRESUNT_RFC: { rfc: "PRESUNT_RFC", nombre: "Presunto", situacion: "PRESUNTO" },
  },
};

const ART69_BLOB = {
  generatedAt: "2026-04-15T02:00:00.000Z",
  source: "http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69.csv",
  rows: {
    DEBTOR_RFC: { rfc: "DEBTOR_RFC", nombre: "Debtor", tipo_adeudo: "Firme", monto: "1000" },
  },
};

function makeDownload(payload) {
  return async () => [Buffer.from(JSON.stringify(payload))];
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FIREBASE_STORAGE_BUCKET = "vida-finance.appspot.com";
  client.__resetForTests();

  // Route downloads by path
  mockDownload.mockImplementation(async () => {
    throw new Error("mockDownload default — override in test");
  });
  mockFile.mockImplementation((path) => ({
    download: path.endsWith("efos.json")
      ? makeDownload(EFOS_BLOB)
      : makeDownload(ART69_BLOB),
  }));
});

describe("check69B", () => {
  it("returns hardReject:true for DEFINITIVO", async () => {
    const result = await client.check69B("DEFAULT_RFC");
    expect(result.rfc).toBe("DEFAULT_RFC");
    expect(result.situacion).toBe("DEFINITIVO");
    expect(result.pass).toBe(false);
    expect(result.flag).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.raw.source).toBe("sat-local");
    expect(result.raw.generatedAt).toBe("2026-04-15T02:00:00.000Z");
  });

  it("returns flag:true for PRESUNTO", async () => {
    const result = await client.check69B("PRESUNT_RFC");
    expect(result.situacion).toBe("PRESUNTO");
    expect(result.pass).toBe(false);
    expect(result.flag).toBe(true);
    expect(result.hardReject).toBe(false);
  });

  it("returns pass:true for RFC not in the list", async () => {
    const result = await client.check69B("CLEAN_RFC");
    expect(result.situacion).toBeNull();
    expect(result.pass).toBe(true);
    expect(result.flag).toBe(false);
    expect(result.hardReject).toBe(false);
  });
});

describe("checkArt69", () => {
  it("returns hasDebt:true when RFC is on the list", async () => {
    const result = await client.checkArt69("DEBTOR_RFC");
    expect(result.rfc).toBe("DEBTOR_RFC");
    expect(result.hasDebt).toBe(true);
    expect(result.count).toBe(1);
    expect(result.pass).toBe(false);
  });

  it("returns pass:true when RFC is not on the list", async () => {
    const result = await client.checkArt69("CLEAN_RFC");
    expect(result.hasDebt).toBe(false);
    expect(result.count).toBe(0);
    expect(result.pass).toBe(true);
  });
});

describe("load dedupe", () => {
  it("downloads each GCS blob exactly once across many concurrent callers", async () => {
    await Promise.all([
      client.check69B("CLEAN_RFC"),
      client.check69B("PRESUNT_RFC"),
      client.checkArt69("DEBTOR_RFC"),
      client.checkArt69("CLEAN_RFC"),
      client.check69B("DEFAULT_RFC"),
    ]);

    const efosCalls = mockFile.mock.calls.filter((c) => c[0] === "sat/efos.json").length;
    const art69Calls = mockFile.mock.calls.filter((c) => c[0] === "sat/art69.json").length;
    expect(efosCalls).toBe(1);
    expect(art69Calls).toBe(1);
  });
});

describe("failure modes", () => {
  it("throws when FIREBASE_STORAGE_BUCKET is unset", async () => {
    delete process.env.FIREBASE_STORAGE_BUCKET;
    await expect(client.check69B("ANY")).rejects.toThrow(
      /FIREBASE_STORAGE_BUCKET not configured/
    );
  });

  it("propagates GCS download errors so employer-a escalates", async () => {
    mockFile.mockImplementation(() => ({
      download: async () => {
        throw new Error("GCS 404");
      },
    }));
    await expect(client.check69B("ANY")).rejects.toThrow(/GCS 404/);
  });
});

describe("drop-in compatibility with sw-client", () => {
  it("check69B return shape has the same top-level keys as sw-client", async () => {
    const result = await client.check69B("CLEAN_RFC");
    expect(Object.keys(result).sort()).toEqual(
      ["flag", "hardReject", "pass", "raw", "rfc", "situacion"].sort()
    );
  });

  it("checkArt69 return shape has the same top-level keys as sw-client", async () => {
    const result = await client.checkArt69("CLEAN_RFC");
    expect(Object.keys(result).sort()).toEqual(
      ["count", "hasDebt", "pass", "raw", "rfc"].sort()
    );
  });
});

describe("getSWToken", () => {
  it("throws a helpful error (not a valid operation for the local provider)", async () => {
    await expect(client.getSWToken()).rejects.toThrow(/no token concept/);
  });
});
