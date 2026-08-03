"use strict";
/**
 * Provenance for the Stage 3 auto-approve conditions (#458).
 *
 * `evaluateAutoApprove` is the shipped function (stage3-autoapprove.js) —
 * NOT the spec in stage3-autoapprove.test.js, which documents an unbuilt,
 * disagreeing gate (see the header of that file / #387). These tests exercise
 * the real ten-condition function decision-engine.js actually calls.
 */
const { evaluateAutoApprove } = require("../stage3-autoapprove");

const APPLICANT = {
  rfc: "GARA900101ABC",
  curp: "GARA900101HDFRRL09",
  age: 35,
  employerTier: 1,
  employmentTenureMonths: 36,
};

const ALL_DATA_PRESENT = {
  employerB: { data: { tier: 1 } },
  stage0: { data: { riskseal: { score: 72 } } },
  stage1: { data: { age: 35, cnbv: { pass: true, riskLevel: "bajo" } } },
  stage2: {
    data: {
      imss: { tenureMonths: 36 },
      bureau: { score: 720, activeDefaults: 0, competitorLoans: 0 },
      lti: { value: 13.64 },
      mlScore: { default_probability: 0.18, underwritingScore: 0.82 },
    },
  },
};

function conditionByName(conditions, name) {
  const cond = conditions.find((c) => c.name === name);
  expect(cond).toBeDefined();
  return cond;
}

describe("evaluateAutoApprove — condition provenance (#458)", () => {
  it("marks every condition as read when all upstream data is present", () => {
    const conditions = evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT);
    expect(conditions).toHaveLength(10);
    for (const cond of conditions) {
      expect(cond.source).toBe("read");
    }
  });

  it("does not change any pass value when all upstream data is present", () => {
    const conditions = evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT);
    expect(conditions.every((c) => c.pass)).toBe(true);
  });

  it("marks bureau_score, no_active_defaults and no_competitor_loans unread from a single bureau outage, without changing their pass values", () => {
    const bureauOutage = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          // Same wholesale replacement stage2-bureau.js:183-189 performs when
          // the bureau call fails.
          bureau: { score: 500, hasBureauRecord: false, activeDefaults: 0, competitorLoans: 0, skipped: true, error: "timeout" },
        },
      },
    };

    const conditions = evaluateAutoApprove(APPLICANT, bureauOutage);

    const bureauScore = conditionByName(conditions, "bureau_score");
    const noActiveDefaults = conditionByName(conditions, "no_active_defaults");
    const noCompetitorLoans = conditionByName(conditions, "no_competitor_loans");

    expect(bureauScore.source).toBe("assumed");
    expect(noActiveDefaults.source).toBe("assumed");
    expect(noCompetitorLoans.source).toBe("assumed");

    // The pass booleans today: bureau_score correctly fails at the 500
    // fallback, while the two count-based conditions read a false pass on
    // data nobody read. Piece 1 must not touch any of these three.
    expect(bureauScore.pass).toBe(false);
    expect(noActiveDefaults.pass).toBe(true);
    expect(noCompetitorLoans.pass).toBe(true);

    // Everything not driven by stage2Data.bureau is unaffected.
    expect(conditionByName(conditions, "imss_tenure").source).toBe("read");
    expect(conditionByName(conditions, "lti").source).toBe("read");
  });

  it("marks imss_tenure unread when the IMSS block is skipped, independent of the bureau block", () => {
    const imssFailure = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          imss: { active: false, skipped: true, error: "belvo down" },
        },
      },
    };

    const conditions = evaluateAutoApprove(APPLICANT, imssFailure);
    const tenure = conditionByName(conditions, "imss_tenure");
    expect(tenure.source).toBe("assumed");
    // Fallback is applicant.employmentTenureMonths (36) — still passes today.
    expect(tenure.pass).toBe(true);
    expect(conditionByName(conditions, "bureau_score").source).toBe("read");
  });

  it("marks ml_default_prob unread when the ML block is skipped", () => {
    const mlFailure = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          mlScore: { skipped: true, error: "ml service down" },
        },
      },
    };

    const conditions = evaluateAutoApprove(APPLICANT, mlFailure);
    const mlCond = conditionByName(conditions, "ml_default_prob");
    expect(mlCond.source).toBe("assumed");
    expect(mlCond.pass).toBe(false); // !mlScore?.skipped is false — fails, as today
  });

  it("marks riskseal_score and sector_safe unread when their blocks are absent or skipped", () => {
    const missingBlocks = {
      employerB: { data: { tier: 1 } },
      stage0: { data: {} }, // no riskseal key at all
      stage1: { data: { age: 35, cnbv: { pass: true, skipped: true } } },
      stage2: ALL_DATA_PRESENT.stage2,
    };

    const conditions = evaluateAutoApprove(APPLICANT, missingBlocks);
    const riskseal = conditionByName(conditions, "riskseal_score");
    const sectorSafe = conditionByName(conditions, "sector_safe");

    expect(riskseal.source).toBe("assumed");
    expect(sectorSafe.source).toBe("assumed");
    // Fallbacks: riskseal ?? 100 passes; cnbv.pass !== false (true) passes.
    expect(riskseal.pass).toBe(true);
    expect(sectorSafe.pass).toBe(true);
  });

  it("marks employer_tier and age_range unread when their stages never ran (whole-stage failure)", () => {
    const stagesAbsent = {
      // decision-engine.js's STAGE_ERROR catch omits `data` entirely.
      employerB: { pass: false, reason: "STAGE_ERROR", error: "boom" },
      stage0: { data: { riskseal: { score: 72 } } },
      stage1: { data: {} }, // no `age` key
      stage2: ALL_DATA_PRESENT.stage2,
    };

    const conditions = evaluateAutoApprove(
      { ...APPLICANT, employerTier: 2, age: 40 },
      stagesAbsent,
    );

    const employerTier = conditionByName(conditions, "employer_tier");
    const ageRange = conditionByName(conditions, "age_range");

    expect(employerTier.source).toBe("assumed");
    expect(ageRange.source).toBe("assumed");
    // Fallbacks: applicant.employerTier (2, <=2 passes); applicant.age (40, in range).
    expect(employerTier.pass).toBe(true);
    expect(ageRange.pass).toBe(true);
  });

  it("marks lti unread when the whole stage2 block never ran", () => {
    const stage2Absent = {
      ...ALL_DATA_PRESENT,
      stage2: { pass: true, reason: "STAGE_ERROR_DEGRADED", data: {} },
    };

    const conditions = evaluateAutoApprove(APPLICANT, stage2Absent);
    const lti = conditionByName(conditions, "lti");
    expect(lti.source).toBe("assumed");
    expect(lti.pass).toBe(true); // lti || 0 <= 25 — unchanged fallback behaviour
  });
});
