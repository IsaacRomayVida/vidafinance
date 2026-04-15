"use strict";

/* ------------------------------------------------------------------ */
/*  Mock the Belvo SDK                                                */
/* ------------------------------------------------------------------ */
const mockConnect = jest.fn().mockResolvedValue(undefined);
const MockBelvoClient = jest.fn().mockImplementation(() => ({
  connect: mockConnect,
  links: { register: jest.fn(), delete: jest.fn() },
  employmentRecords: { retrieve: jest.fn() },
  incomes: { retrieve: jest.fn() },
}));
jest.mock("belvo", () => ({ default: MockBelvoClient }));

/* ------------------------------------------------------------------ */
/*  Clear singleton between tests                                     */
/* ------------------------------------------------------------------ */
let belvoClient;
beforeEach(() => {
  jest.resetModules();
  MockBelvoClient.mockClear();
  mockConnect.mockClear();
  // Re-require to reset the singleton _client
  jest.isolateModules(() => {
    belvoClient = require("./belvo-client");
  });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("belvo-client: getClient", () => {
  test("should default to sandbox URL when BELVO_BASE_URL is not set", async () => {
    delete process.env.BELVO_BASE_URL;
    process.env.BELVO_SECRET_ID = "test-id";
    process.env.BELVO_SECRET_PASSWORD = "test-pass";

    await belvoClient.getClient();

    expect(MockBelvoClient).toHaveBeenCalledWith(
      "test-id",
      "test-pass",
      "https://sandbox.belvo.com"
    );
  });

  test("should use BELVO_BASE_URL when explicitly set", async () => {
    process.env.BELVO_BASE_URL = "https://sandbox.belvo.com";
    process.env.BELVO_SECRET_ID = "test-id";
    process.env.BELVO_SECRET_PASSWORD = "test-pass";

    await belvoClient.getClient();

    expect(MockBelvoClient).toHaveBeenCalledWith(
      "test-id",
      "test-pass",
      "https://sandbox.belvo.com"
    );
  });

  test("should use sandbox CURP BLPM951331IONVGR54 for IMSS employment lookup", async () => {
    process.env.BELVO_BASE_URL = "https://sandbox.belvo.com";
    process.env.BELVO_SECRET_ID = "test-id";
    process.env.BELVO_SECRET_PASSWORD = "test-pass";

    const mockLink = { id: "link-123" };
    const mockRecords = [
      {
        curp: "BLPM951331IONVGR54",
        employer_rfc: "RFC123456789",
        base_salary: 15000,
        tenure_months: 36,
      },
    ];

    // Get client first to set up the mock
    const client = await belvoClient.getClient();
    client.links.register.mockResolvedValue(mockLink);
    client.employmentRecords.retrieve.mockResolvedValue(mockRecords);
    client.links.delete.mockResolvedValue(undefined);

    const result = await belvoClient.getIMSSEmployment("BLPM951331IONVGR54");

    expect(client.links.register).toHaveBeenCalledWith(
      "imss_mx_employment",
      "BLPM951331IONVGR54",
      "",
      { accessMode: "single" }
    );
    expect(result).toEqual(mockRecords);
    expect(result[0].curp).toBe("BLPM951331IONVGR54");
  });
});
