"use strict";
/**
 * Provenance and fail-closed behaviour for the Stage 3 auto-approve
 * conditions (#458).
 *
 * `evaluateAutoApprove` is the shipped function (stage3-autoapprove.js) —
 * NOT the spec in stage3-autoapprove.test.js, which documents an unbuilt,
 * disagreeing gate (see the header of that file / #387). These tests exercise
 * the real ten-condition function decision-engine.js actually calls.
 *
 * #459 added `source` and deliberately changed nothing; the `pass` assertions
 * here recorded the fail-OPEN behaviour of the day. They now assert the
 * opposite: a condition whose value was never read cannot clear its bound.
 * The single exception is `no_competitor_loans` — see its own case below.
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

  it("emits byte-identical conditions to the pre-#458 gate when every value was read", () => {
    // The whole change is confined to unread data. A borrower whose pipeline
    // ran cleanly must see the same ten conditions, the same values and the
    // same pass results as before — no threshold or bound moved.
    //
    // One `required` string did move: employer_tier reads "1-2" rather than
    // "<= 2", because the condition now states its lower bound instead of
    // resting on employer-b never emitting tier 0. employer-b emits only 1, 2
    // or 3, so no live decision changes — see the tier-0 case below for the
    // reason the bound is written down anyway.
    expect(evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT)).toEqual([
      { name: "employer_tier", pass: true, value: 1, required: "1-2", source: "read" },
      { name: "imss_tenure", pass: true, value: 36, required: "> 6 months", source: "read" },
      { name: "bureau_score", pass: true, value: 720, required: "> 600", source: "read" },
      { name: "lti", pass: true, value: 13.64, required: "<= 25%", source: "read" },
      { name: "no_competitor_loans", pass: true, value: 0, required: "0", source: "read" },
      { name: "riskseal_score", pass: true, value: 72, required: "> 60", source: "read" },
      { name: "sector_safe", pass: true, value: "bajo", required: "not alto", source: "read" },
      { name: "ml_default_prob", pass: true, value: 0.18, required: "< 0.35", source: "read" },
      { name: "no_active_defaults", pass: true, value: 0, required: "0", source: "read" },
      { name: "age_range", pass: true, value: 35, required: "18-65", source: "read" },
    ]);
  });

  it("declines a tier-0 employer instead of approving it, without relying on employer-b's encoding", () => {
    // ADR-005 Finding 3: the spec encodes a rejected employer as tier 0 while
    // shipped code uses 3. Under a bare `<= 2` upper bound a spec-conformant 0
    // is the *best* possible tier and clears condition 1 — a worker at a
    // rejected employer walks the gate. Nothing in this repo produces a 0
    // today, which is exactly why it is worth pinning: the safety of condition
    // 1 should not be a property of employer-b's current branch layout.
    const rejectedEmployer = {
      ...ALL_DATA_PRESENT,
      employerB: { data: { ...ALL_DATA_PRESENT.employerB.data, tier: 0 } },
    };
    const tierCondition = evaluateAutoApprove(APPLICANT, rejectedEmployer)
      .find((c) => c.name === "employer_tier");

    // Read, so this is a credit decline rather than an outage escalation.
    expect(tierCondition).toEqual({
      name: "employer_tier", pass: false, value: 0, required: "1-2", source: "read",
    });
  });

  it("marks bureau_score, no_active_defaults and no_competitor_loans unread from a single bureau outage, and fails all three closed", () => {
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

    // Before #458 only bureau_score failed, at its 500 fallback; the two
    // count-based conditions read a false pass off the wholesale error stub,
    // whose `activeDefaults: 0` and `competitorLoans: 0` are fabricated by the
    // catch block rather than observed. All three now fail closed.
    expect(bureauScore.pass).toBe(false);
    expect(noActiveDefaults.pass).toBe(false);
    expect(noCompetitorLoans.pass).toBe(false);

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
    // The fallback is applicant.employmentTenureMonths (36), which used to
    // carry this condition through a Belvo outage on the applicant's own
    // word. A self-reported tenure is not an IMSS record.
    expect(tenure.pass).toBe(false);
    expect(conditionByName(conditions, "bureau_score").source).toBe("read");
    expect(conditionByName(conditions, "bureau_score").pass).toBe(true);
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
    // The `?? 100` fallback made a fraud score nobody fetched read as a
    // perfect one, and `pass !== false` made a sector nobody looked up read as
    // not-high-risk. Both now fail closed. The reported values are unchanged,
    // so the failure line still shows what the gate was working from.
    expect(riskseal.pass).toBe(false);
    expect(riskseal.value).toBe(100);
    expect(sectorSafe.pass).toBe(false);
    expect(sectorSafe.value).toBe("unknown");
  });

  it("fails sector_safe closed on the no-sector-to-check shape stage 1 emits by default", () => {
    // stage1-identity.js:96-103 returns `{pass: true, skipped: true}` whenever
    // there is no Firestore handle or no sectorCode — the CNBV registry was
    // never consulted. `pass: true` there means "nothing rejected this", not
    // "the sector is safe", and it must not clear the condition.
    const conditions = evaluateAutoApprove(APPLICANT, {
      ...ALL_DATA_PRESENT,
      stage1: { data: { age: 35, cnbv: { pass: true, skipped: true } } },
    });

    const sectorSafe = conditionByName(conditions, "sector_safe");
    expect(sectorSafe.source).toBe("assumed");
    expect(sectorSafe.pass).toBe(false);
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
    // The fallbacks were applicant.employerTier (2) and applicant.age (40) —
    // both caller-supplied, both used to pass. ADR-005 Finding 3: `||` cannot
    // tell an absent tier from a zero one, and the caller is not a source of
    // truth for a value the pipeline computes itself.
    expect(employerTier.pass).toBe(false);
    expect(ageRange.pass).toBe(false);
  });

  it("does not let a stale applicant.employerTier stand in for a tier employer part B never returned", () => {
    // The concrete hazard ADR-005 Finding 3 names: a self-reported or stale
    // tier 1 on the applicant, and no tier from the pipeline at all.
    const conditions = evaluateAutoApprove(
      { ...APPLICANT, employerTier: 1 },
      { ...ALL_DATA_PRESENT, employerB: { pass: false, reason: "STAGE_ERROR", error: "boom" } },
    );

    const employerTier = conditionByName(conditions, "employer_tier");
    expect(employerTier.source).toBe("assumed");
    expect(employerTier.pass).toBe(false);
    expect(employerTier.value).toBeNull();
  });

  it("still reads a tier the pipeline did return, including a rejected tier 3", () => {
    // Removing the `||` chain must not change what a present tier means.
    // Rejected employers stay encoded as 3 (employer-b.js:76) and fail on the
    // bound, not on provenance.
    const conditions = evaluateAutoApprove(APPLICANT, {
      ...ALL_DATA_PRESENT,
      employerB: { data: { tier: 3 } },
    });

    const employerTier = conditionByName(conditions, "employer_tier");
    expect(employerTier.source).toBe("read");
    expect(employerTier.value).toBe(3);
    expect(employerTier.pass).toBe(false);
  });

  it("marks lti unread when the whole stage2 block never ran", () => {
    const stage2Absent = {
      ...ALL_DATA_PRESENT,
      stage2: { pass: true, reason: "STAGE_ERROR_DEGRADED", data: {} },
    };

    const conditions = evaluateAutoApprove(APPLICANT, stage2Absent);
    const lti = conditionByName(conditions, "lti");
    expect(lti.source).toBe("assumed");
    // `lti || 0` and `0 <= 25` always passed — the same hazard
    // decision-engine.js:67-73 names for a missing principal, one layer up.
    expect(lti.pass).toBe(false);
  });

  it("does not auto-approve on a whole-stage-2 failure", () => {
    // decision-engine.js:148 turns a Stage 2 throw into
    // `{pass: true, reason: "STAGE_ERROR_DEGRADED", data: {}}` and carries on,
    // so an empty object reaches this gate. Before #458 the entire margin
    // between a total Stage 2 outage and an auto-approval was bureau_score's
    // 500 fallback and ml_default_prob's 0.5 — two conditions.
    const conditions = evaluateAutoApprove(APPLICANT, {
      ...ALL_DATA_PRESENT,
      stage2: { pass: true, reason: "STAGE_ERROR_DEGRADED", error: "boom", data: {} },
    });

    expect(conditions.every((c) => c.pass)).toBe(false);
    const failed = conditions.filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toEqual([
      "imss_tenure",
      "bureau_score",
      "lti",
      "ml_default_prob",
      "no_active_defaults",
    ]);
    // Every one of them failed because its data was unread, not because the
    // applicant missed a bound — which is what ops has to be able to tell apart.
    for (const name of failed) {
      expect(conditionByName(conditions, name).source).toBe("assumed");
    }
  });

  it("fails 9 of 10 closed on all-null input, with no_competitor_loans the sole pass", () => {
    // ADR-005 Finding 8's acceptance criterion, translated from the skipped
    // spec's flat params (stage3-autoapprove.test.js:253-269) to this gate's
    // signature: nothing read, anywhere.
    //
    // no_competitor_loans is the one legitimate pass. Every other condition
    // tests a bound on a value that has to be obtained, so its absence is
    // ignorance; this one tests the absence of a finding in an account list,
    // and with no bureau block there is no account list to hold one. It is
    // safe rather than merely convenient: bureau_score and no_active_defaults
    // read the same missing block and both fail, and all ten must hold, so
    // this pass can never be the margin between an outage and an approval.
    const conditions = evaluateAutoApprove({}, {});

    expect(conditions).toHaveLength(10);
    const passed = conditions.filter((c) => c.pass);
    expect(passed.map((c) => c.name)).toEqual(["no_competitor_loans"]);
    expect(conditions.filter((c) => !c.pass)).toHaveLength(9);
    for (const cond of conditions) {
      expect(cond.source).toBe("assumed");
    }
  });

  it("holds the invariant: an assumed value never clears a condition, bar the one exception", () => {
    const shapes = [
      ["nothing at all", {}, {}],
      ["all data present", APPLICANT, ALL_DATA_PRESENT],
      ["stage 2 wiped", APPLICANT, { ...ALL_DATA_PRESENT, stage2: { data: {} } }],
      ["stage 1 wiped", APPLICANT, { ...ALL_DATA_PRESENT, stage1: { data: {} } }],
      ["stage 0 wiped", APPLICANT, { ...ALL_DATA_PRESENT, stage0: { data: {} } }],
      ["employer B wiped", APPLICANT, { ...ALL_DATA_PRESENT, employerB: {} }],
      [
        "every stage2 block skipped",
        APPLICANT,
        {
          ...ALL_DATA_PRESENT,
          stage2: {
            data: {
              imss: { skipped: true },
              bureau: { score: 500, activeDefaults: 0, competitorLoans: 0, skipped: true },
              lti: { skipped: true },
              mlScore: { skipped: true },
            },
          },
        },
      ],
    ];

    for (const [label, applicant, allResults] of shapes) {
      for (const cond of evaluateAutoApprove(applicant, allResults)) {
        if (cond.source === "assumed" && cond.name !== "no_competitor_loans") {
          expect(`${label}/${cond.name}/${cond.pass}`).toBe(`${label}/${cond.name}/false`);
        }
      }
    }
  });
});
