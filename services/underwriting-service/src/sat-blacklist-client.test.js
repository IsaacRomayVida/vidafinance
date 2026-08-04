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

  // clearAllMocks() clears calls but not implementations — reset the Redis
  // stubs explicitly so a cache-shaped test cannot leak into the next one.
  const redisMock = require("./redis-client");
  redisMock.get.mockImplementation(async () => null);
  redisMock.set.mockImplementation(async () => "OK");

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

// ── Structurally-empty blob must not read as "nobody is blacklisted" ──────
//
// The header contract of this module is "We never silently pass when SAT data
// is missing". A blob that is *absent* or *unparseable* honours that: download
// or JSON.parse throws, employer-a's Promise.allSettled turns it into
// { pass:false, skipped:true } and escalates to Stage 5.
//
// A blob that is present and parseable but carries no rows does not. It loads
// as an empty Map, so every RFC lookup misses, so situacion is null and hasDebt
// is false, and every employer in the country clears 69-B and Art. 69 screening
// with pass:true — indistinguishable from a genuinely clean employer.
describe("empty / structurally-invalid blob", () => {
  function serveEfos(efosPayload) {
    mockFile.mockImplementation((path) => ({
      download: path.endsWith("efos.json")
        ? makeDownload(efosPayload)
        : makeDownload(ART69_BLOB),
    }));
  }
  function serveArt69(art69Payload) {
    mockFile.mockImplementation((path) => ({
      download: path.endsWith("efos.json")
        ? makeDownload(EFOS_BLOB)
        : makeDownload(art69Payload),
    }));
  }

  it("rejects rather than passing when the EFOS blob has zero rows", async () => {
    serveEfos({ generatedAt: "2026-04-15T02:00:00.000Z", source: "x", rows: {} });
    await expect(client.check69B("ANY_RFC")).rejects.toThrow(/0 rows/);
  });

  it("rejects rather than passing when the Art. 69 blob has zero rows", async () => {
    serveArt69({ generatedAt: "2026-04-15T02:00:00.000Z", source: "x", rows: {} });
    await expect(client.checkArt69("ANY_RFC")).rejects.toThrow(/0 rows/);
  });

  it("rejects when the EFOS blob has no `rows` key at all", async () => {
    serveEfos({ generatedAt: "2026-04-15T02:00:00.000Z", source: "x" });
    await expect(client.check69B("ANY_RFC")).rejects.toThrow(/sat\/efos\.json/);
  });

  it("rejects when the blob is valid JSON of the wrong shape (bare array)", async () => {
    serveEfos([]);
    await expect(client.check69B("ANY_RFC")).rejects.toThrow(/sat\/efos\.json/);
  });

  it("rejects when `rows` is an array instead of an rfc-keyed object", async () => {
    // Object.entries() on an array yields index keys ("0", "1"), so the map
    // loads "successfully" and no RFC can ever match it.
    serveEfos({
      generatedAt: "2026-04-15T02:00:00.000Z",
      rows: [{ rfc: "DEFAULT_RFC", situacion: "DEFINITIVO" }],
    });
    await expect(client.check69B("DEFAULT_RFC")).rejects.toThrow(/sat\/efos\.json/);
  });

  it("does not write a pass into the Redis cache when the blob is empty", async () => {
    const redisMock = require("./redis-client");
    serveEfos({ generatedAt: "2026-04-15T02:00:00.000Z", rows: {} });
    await client.check69B("ANY_RFC").catch(() => {});
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("keeps the last-good in-memory list when a later refresh returns empty", async () => {
    // Warm up on good data.
    expect((await client.check69B("DEFAULT_RFC")).hardReject).toBe(true);

    // 4h later the scheduled reload picks up an empty blob. It must not
    // overwrite the loaded table with an empty one.
    serveEfos({ generatedAt: "2026-05-15T02:00:00.000Z", rows: {} });
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60 * 60 * 1000);
    await client.check69B("DEFAULT_RFC").catch(() => {});
    Date.now.mockRestore();

    // Restore a healthy blob; the DEFINITIVO must still be known.
    mockFile.mockImplementation((path) => ({
      download: path.endsWith("efos.json")
        ? makeDownload(EFOS_BLOB)
        : makeDownload(ART69_BLOB),
    }));
    expect((await client.check69B("DEFAULT_RFC")).hardReject).toBe(true);
  });
});

// ── Per-RFC Redis cache is not scoped to the dataset it was computed from ─
//
// check69B/checkArt69 cache under `sat:69b:<rfc>` / `sat:art69:<rfc>` for 24h
// with nothing in the key identifying which SAT dataset produced the answer.
// A pass computed while the blacklist was empty therefore keeps being served
// for a full day after the data is restored.
describe("cache is scoped to the dataset generation", () => {
  it("does not serve a 69-B pass computed from a different dataset generation", async () => {
    const redisMock = require("./redis-client");
    // A pass banked under the legacy/other-generation key.
    redisMock.get.mockImplementation(async (key) =>
      key.includes("2026-04-15") ? null : JSON.stringify({ rfc: "DEFAULT_RFC", situacion: null, pass: true })
    );

    const result = await client.check69B("DEFAULT_RFC");
    expect(result.pass).toBe(false);
    expect(result.hardReject).toBe(true);
  });

  it("does not serve an Art. 69 pass computed from a different dataset generation", async () => {
    const redisMock = require("./redis-client");
    redisMock.get.mockImplementation(async (key) =>
      key.includes("2026-04-15") ? null : JSON.stringify({ rfc: "DEBTOR_RFC", hasDebt: false, pass: true })
    );

    const result = await client.checkArt69("DEBTOR_RFC");
    expect(result.pass).toBe(false);
    expect(result.hasDebt).toBe(true);
  });

  it("still serves a cache hit written by the current dataset generation", async () => {
    const redisMock = require("./redis-client");
    await client.check69B("DEFAULT_RFC"); // populates state.generatedAt
    const key = redisMock.set.mock.calls[0][0];
    expect(key).toContain("2026-04-15T02:00:00.000Z");

    redisMock.get.mockImplementation(async (k) =>
      k === key ? JSON.stringify({ rfc: "DEFAULT_RFC", pass: false, cachedHit: true }) : null
    );
    const result = await client.check69B("DEFAULT_RFC");
    expect(result.cachedHit).toBe(true);
  });
});
