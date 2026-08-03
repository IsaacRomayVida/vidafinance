/**
 * #435 — the pay-frequency feature fed to the credit model.
 *
 * `pay_frequency_encoded` is pay periods per month. It was a ternary with an
 * implicit else (`weekly ? 4 : biweekly ? 2 : 1`), which was survivable only
 * while `semimonthly` could not be written. Part 1 of #435 made it selectable
 * at onboarding, so from that point a borrower paid on the 15th and the last
 * day fell through to 1 and was scored as if paid monthly.
 *
 * These pin the two properties that matter: semimonthly is twice a month like
 * biweekly, and an unrecognised cadence is never silent.
 */
const { encodePayFrequency, PAY_PERIODS_PER_MONTH } = require("./stage2-bureau");

const silentLog = () => ({ warn: jest.fn(), info: jest.fn() });

describe("encodePayFrequency", () => {
  it("scores semimonthly as twice a month, not as monthly", () => {
    // The regression: 'semimonthly' hit the implicit else and encoded as 1.
    expect(encodePayFrequency("semimonthly", silentLog())).toBe(2);
  });

  it("scores semimonthly and biweekly identically", () => {
    // Both are two paydays a month. The distinction between them matters for
    // WHEN the deduction lands (calculateNextPayrollDate), not for how often
    // income arrives, which is all this feature encodes.
    const log = silentLog();
    expect(encodePayFrequency("semimonthly", log)).toBe(encodePayFrequency("biweekly", log));
  });

  it.each([
    ["weekly", 4],
    ["biweekly", 2],
    ["semimonthly", 2],
    ["monthly", 1],
  ])("encodes %s as %i periods per month", (frequency, expected) => {
    expect(encodePayFrequency(frequency, silentLog())).toBe(expected);
  });

  it("logs an unknown cadence instead of silently scoring it as monthly", () => {
    const log = silentLog();
    expect(encodePayFrequency("quincenal", log)).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({ payFrequency: "quincenal" });
  });

  it("logs a missing cadence too", () => {
    const log = silentLog();
    expect(encodePayFrequency(undefined, log)).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("covers every cadence calculateNextPayrollDate has a branch for", () => {
    // The union in functions/src/loans/calculateNextPayrollDate.ts. A value the
    // date calculator understands but this map does not is exactly the gap that
    // produced the defect.
    expect(Object.keys(PAY_PERIODS_PER_MONTH).sort()).toEqual(
      ["biweekly", "monthly", "semimonthly", "weekly"]
    );
  });
});

/**
 * The same property asserted through the public entry point, so this cannot
 * pass merely because a helper was exported: it checks the value that actually
 * reaches the ML service over the wire.
 */
jest.mock("../belvo-client", () => ({
  getIMSSEmployment: jest.fn(async () => {
    throw new Error("skipped in test");
  }),
  getAFORE: jest.fn(async () => {
    throw new Error("skipped in test");
  }),
}));

describe("pay_frequency_encoded as sent to the ML service", () => {
  const applicant = (payFrequency) => ({
    curp: "CURP000000HDFAAA00",
    rfc: "AAAA000000AAA",
    fullName: "Test Borrower",
    monthlySalary: 20000,
    principalAmount: 1000,
    payFrequency,
  });

  const scoreCallFor = async (payFrequency) => {
    const fetch = require("node-fetch");
    fetch.mockReset();
    fetch.mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/score") ? { score: 0.5 } : { bureau_score: 600 }),
    }));

    const { runBureauAndEmployment } = require("./stage2-bureau");
    await runBureauAndEmployment(applicant(payFrequency), {}, {
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const call = fetch.mock.calls.find(([url]) => String(url).includes("/score"));
    return JSON.parse(call[1].body).pay_frequency_encoded;
  };

  it("sends 2 for a borrower paid on the 15th and the last day", async () => {
    // The defect: this was 1, so the model saw monthly income.
    await expect(scoreCallFor("semimonthly")).resolves.toBe(2);
  });

  it("still sends 4 for weekly and 1 for monthly", async () => {
    await expect(scoreCallFor("weekly")).resolves.toBe(4);
    await expect(scoreCallFor("monthly")).resolves.toBe(1);
  });
});
