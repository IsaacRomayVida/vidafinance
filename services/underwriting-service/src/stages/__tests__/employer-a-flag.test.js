"use strict";
/**
 * Tests the EMPLOYER_SAT_PROVIDER feature flag: confirms employer-a wires
 * sw-client when set to "sw" and sat-blacklist-client otherwise. Runs with
 * isolateModules so each case resets the module graph.
 */

describe("employer-a provider selection", () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.EMPLOYER_SAT_PROVIDER;
  });

  it("defaults to sat-blacklist-client when EMPLOYER_SAT_PROVIDER is unset", () => {
    delete process.env.EMPLOYER_SAT_PROVIDER;
    const swCheck69B = jest.fn();
    const localCheck69B = jest.fn();

    jest.isolateModules(() => {
      jest.doMock("../../redis-client", () => ({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
      }));
      const cleanArt69 = { rfc: "RFC", hasDebt: false, count: 0, pass: true };
      jest.doMock("../../sw-client", () => ({
        check69B: swCheck69B,
        checkArt69: jest.fn().mockResolvedValue(cleanArt69),
      }));
      jest.doMock("../../sat-blacklist-client", () => ({
        check69B: localCheck69B,
        checkArt69: jest.fn().mockResolvedValue(cleanArt69),
      }));
      jest.doMock("../../gov-apis", () => ({
        checkDENUE: jest.fn().mockResolvedValue({ pass: true }),
        checkREPSE: jest.fn().mockResolvedValue({ pass: true }),
      }));
      localCheck69B.mockResolvedValue({
        rfc: "RFC",
        situacion: null,
        pass: true,
        flag: false,
        hardReject: false,
      });

      const { runEmployerScreening } = require("../employer-a");
      return runEmployerScreening({ rfc: "RFC", companyName: "Test", stateCode: "09" }).then(
        () => {
          expect(localCheck69B).toHaveBeenCalledWith("RFC");
          expect(swCheck69B).not.toHaveBeenCalled();
        }
      );
    });
  });

  it("uses sw-client when EMPLOYER_SAT_PROVIDER=sw", () => {
    process.env.EMPLOYER_SAT_PROVIDER = "sw";
    const swCheck69B = jest.fn();
    const localCheck69B = jest.fn();

    jest.isolateModules(() => {
      jest.doMock("../../redis-client", () => ({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
      }));
      jest.doMock("../../sw-client", () => ({
        check69B: swCheck69B,
        checkArt69: jest.fn().mockResolvedValue({
          rfc: "RFC",
          hasDebt: false,
          count: 0,
          pass: true,
        }),
      }));
      jest.doMock("../../sat-blacklist-client", () => ({
        check69B: localCheck69B,
        checkArt69: jest.fn(),
      }));
      jest.doMock("../../gov-apis", () => ({
        checkDENUE: jest.fn().mockResolvedValue({ pass: true }),
        checkREPSE: jest.fn().mockResolvedValue({ pass: true }),
      }));
      swCheck69B.mockResolvedValue({
        rfc: "RFC",
        situacion: null,
        pass: true,
        flag: false,
        hardReject: false,
      });

      const { runEmployerScreening } = require("../employer-a");
      return runEmployerScreening({ rfc: "RFC", companyName: "Test", stateCode: "09" }).then(
        (result) => {
          expect(swCheck69B).toHaveBeenCalledWith("RFC");
          expect(localCheck69B).not.toHaveBeenCalled();
          // sw provider produces cost items; local produces none.
          expect(result.cost).toEqual(
            expect.arrayContaining([{ api: "sw-69b", mxn: 0.5 }])
          );
        }
      );
    });
  });
});
