"use strict";

jest.mock("belvo");

const { extractBelvoError, resolveBelvoBaseUrl, getClient } = require("./belvo-client");

describe("extractBelvoError", () => {
  it("captures message, code, and detail from Belvo SDK error", () => {
    const err = new Error("institution_not_available");
    err.statusCode = 400;
    err.detail = "imss_mx_employment is not enabled in sandbox";

    const result = extractBelvoError(err, "getIMSSEmployment");
    expect(result.context).toBe("getIMSSEmployment");
    expect(result.message).toBe("institution_not_available");
    expect(result.code).toBe(400);
    expect(result.detail).toBe("imss_mx_employment is not enabled in sandbox");
    expect(result.summary).toContain("getIMSSEmployment");
    expect(result.summary).toContain("status=400");
    expect(result.summary).toContain("institution_not_available");
  });

  it("handles empty message errors", () => {
    const err = new Error("");
    const result = extractBelvoError(err, "getAFORE");
    expect(result.message).toBe("(empty message)");
    expect(result.summary).toContain("getAFORE");
  });

  it("extracts JSON body from err.body string", () => {
    const err = new Error("");
    err.body = JSON.stringify({ code: "login_error", message: "Invalid credentials" });

    const result = extractBelvoError(err, "getIMSSEmployment");
    expect(result.body).toEqual({ code: "login_error", message: "Invalid credentials" });
    expect(result.summary).toContain("login_error");
  });

  it("extracts body from err.response object", () => {
    const err = new Error("");
    err.response = { body: { code: "timeout", message: "Request timed out" } };

    const result = extractBelvoError(err, "getAFORE");
    expect(result.body).toEqual({ code: "timeout", message: "Request timed out" });
  });

  it("extracts body from err.response.data", () => {
    const err = new Error("");
    err.response = { data: { error: "sandbox_not_enabled" } };

    const result = extractBelvoError(err, "getIMSSEmployment");
    expect(result.body).toEqual({ error: "sandbox_not_enabled" });
  });

  it("preserves stack trace", () => {
    const err = new Error("test error");
    const result = extractBelvoError(err, "getIMSSEmployment");
    expect(result.stack).toBeTruthy();
    expect(result.stack).toContain("test error");
  });

  it("handles err.code fallback", () => {
    const err = new Error("ECONNREFUSED");
    err.code = "ECONNREFUSED";

    const result = extractBelvoError(err, "getIMSSEmployment");
    expect(result.code).toBe("ECONNREFUSED");
  });
});

describe("resolveBelvoBaseUrl", () => {
  const ORIGINAL_BASE_URL = process.env.BELVO_BASE_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BELVO_BASE_URL = ORIGINAL_BASE_URL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("uses explicit BELVO_BASE_URL when set, regardless of environment", () => {
    process.env.BELVO_BASE_URL = "https://api.belvo.com";
    process.env.NODE_ENV = "production";
    expect(resolveBelvoBaseUrl()).toBe("https://api.belvo.com");
  });

  it("defaults to sandbox when BELVO_BASE_URL is unset and NODE_ENV is not production", () => {
    delete process.env.BELVO_BASE_URL;
    process.env.NODE_ENV = "staging";
    expect(resolveBelvoBaseUrl()).toBe("https://sandbox.belvo.com");
  });

  it("also defaults to sandbox when NODE_ENV is unset entirely", () => {
    delete process.env.BELVO_BASE_URL;
    delete process.env.NODE_ENV;
    expect(resolveBelvoBaseUrl()).toBe("https://sandbox.belvo.com");
  });

  it("fails loudly instead of defaulting to sandbox when BELVO_BASE_URL is unset in production", () => {
    delete process.env.BELVO_BASE_URL;
    process.env.NODE_ENV = "production";
    expect(() => resolveBelvoBaseUrl()).toThrow(/BELVO_BASE_URL/);
  });
});

describe("belvo-client: getClient", () => {
  const ORIGINAL_BASE_URL = process.env.BELVO_BASE_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BELVO_BASE_URL = ORIGINAL_BASE_URL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    require("belvo").default.mockClear();
  });

  it("wires the resolved base URL into the Belvo SDK client", async () => {
    process.env.BELVO_SECRET_ID = "test-id";
    process.env.BELVO_SECRET_PASSWORD = "test-pass";
    process.env.BELVO_BASE_URL = "https://sandbox.belvo.com";
    process.env.NODE_ENV = "staging";

    await getClient();

    expect(require("belvo").default).toHaveBeenCalledWith(
      "test-id",
      "test-pass",
      "https://sandbox.belvo.com"
    );
  });
});
