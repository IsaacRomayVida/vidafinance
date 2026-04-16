"use strict";

jest.mock("belvo");

const { extractBelvoError } = require("./belvo-client");

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
