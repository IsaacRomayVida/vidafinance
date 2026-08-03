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

// stage3-autoapprove.js requires config/maxPDefaultCutoff.js, which requires
// firebase-admin (ADR-005 Finding 5's server-side config seam). Mocked here
// the same way stage2-bureau.test.js and competitorLenders.test.js mock it
// for the SAME seam, so `runAutoApproveGate` tests below can control what the
// config document read returns.
const mockMaxPDefaultConfigGet = jest.fn();
jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({ get: mockMaxPDefaultConfigGet }),
    }),
  }),
}));

const { evaluateAutoApprove, runAutoApproveGate } = require("../stage3-autoapprove");
const { SEED_MAX_PDEFAULT } = require("../../config/maxPDefaultCutoff");

const APPLICANT = {
  rfc: "GARA900101ABC",
  curp: "GARA900101HDFRRL09",
  age: 35,
  employerTier: 1,
  employmentTenureMonths: 36,
};

const ALL_DATA_PRESENT = {
  employerB: { tier: 1 },
  stage0: { data: { riskseal: { score: 72 } } },
  stage1: { data: { age: 35, cnbv: { pass: true, riskLevel: "bajo" } } },
  stage2: {
    data: {
      imss: { tenureMonths: 36 },
      // `competitorLoansByName` is what condition 5 reads as of ADR-006 — the
      // named-match signal derived in stage2-bureau.js — rather than the opaque
      // SoftCrédito `competitorLoans` count, which stays on the fixture because
      // the bureau block still carries it. `diasAtraso`/`carteraVencida` are the
      // fields conditions 11 and 12 read; a clean applicant has 0 and false.
      bureau: {
        score: 720,
        activeDefaults: 0,
        competitorLoans: 0,
        competitorLoansByName: 0,
        diasAtraso: 0,
        carteraVencida: false,
      },
      lti: { value: 13.64 },
      // Real `/score` wire shape (ml-service/main.py:485-494): championScore is
      // P(repayment), so 0.88 is P(default) 0.12. Stated in the contract the ML
      // service actually speaks — the fields this fixture carried before
      // (`default_probability`/`underwritingScore`) appear on no response it has
      // ever sent, which is how condition 8 came to fail for every applicant.
      //
      // 0.12 rather than the 0.18 of the original fixture: ADR-006 ratified
      // MAX_PDEFAULT at 0.15, so 0.18 is now a declining value and could no
      // longer stand for "all data present and every condition passes".
      mlScore: { championScore: 0.88 },
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
    expect(conditions).toHaveLength(12);
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
    // "<= 2", because the condition now states its lower bound explicitly
    // instead of resting on employer-b's branch layout to keep a rejected
    // employer out of range. employer-b now emits tier 0 for a rejected
    // employer (#387/#388), which fails this lower bound on its own — see
    // the tier-0 case below.
    expect(evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT)).toEqual([
      { id: 1, name: "employer_tier", pass: true, value: 1, required: "1-2", source: "read" },
      { id: 2, name: "imss_tenure", pass: true, value: 36, required: "> 6 months", source: "read" },
      { id: 3, name: "bureau_score", pass: true, value: 720, required: "> 600", source: "read" },
      { id: 4, name: "lti", pass: true, value: 13.64, required: "<= 25%", source: "read" },
      { id: 5, name: "no_competitor_loans", pass: true, value: 0, required: "0", source: "read" },
      { id: 6, name: "riskseal_score", pass: true, value: 72, required: "> 60", source: "read" },
      { id: 7, name: "sector_safe", pass: true, value: "bajo", required: "not alto", source: "read" },
      { id: 8, name: "ml_default_prob", pass: true, value: 0.12, required: "< 0.15", source: "read" },
      { id: 9, name: "no_active_defaults", pass: true, value: 0, required: "0", source: "read" },
      { id: 10, name: "age_range", pass: true, value: 35, required: "18-65", source: "read" },
      { id: 11, name: "dias_atraso_zero", pass: true, value: 0, required: "0", source: "read" },
      {
        id: 12,
        name: "cartera_vencida_false",
        pass: true,
        value: false,
        required: "false",
        source: "read",
      },
    ]);
  });

  it("declines a tier-0 employer instead of approving it, without relying on employer-b's encoding", () => {
    // ADR-005 Finding 3: the spec encodes a rejected employer as tier 0, which
    // employer-b now emits (#387/#388). Under a bare `<= 2` upper bound alone,
    // tier 0 would be the *best* possible tier and clear condition 1 — a
    // worker at a rejected employer walking the gate. The explicit lower
    // bound (`>= 1`) is what actually stops that, which is exactly why it is
    // worth pinning: the safety of condition 1 should not be a property of
    // employer-b's current branch layout.
    const rejectedEmployer = {
      ...ALL_DATA_PRESENT,
      employerB: { ...ALL_DATA_PRESENT.employerB, tier: 0 },
    };
    const tierCondition = evaluateAutoApprove(APPLICANT, rejectedEmployer)
      .find((c) => c.name === "employer_tier");

    // Read, so this is a credit decline rather than an outage escalation.
    expect(tierCondition).toEqual({
      id: 1, name: "employer_tier", pass: false, value: 0, required: "1-2", source: "read",
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
      employerB: { tier: 1 },
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

  it("still reads a tier the pipeline did return, including an out-of-range tier 3", () => {
    // Removing the `||` chain must not change what a present tier means.
    // employer-b only ever emits 0, 1 or 2 (#387/#388); this pins that the
    // upper bound itself — not just provenance — is what stops a
    // hypothetical out-of-range tier from clearing condition 1, so the
    // condition's safety does not rest on employer-b's current branch
    // layout ever staying that way.
    const conditions = evaluateAutoApprove(APPLICANT, {
      ...ALL_DATA_PRESENT,
      employerB: { tier: 3 },
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
      // ADR-006's two additions read the same wiped stage 2, so a total
      // Stage 2 outage now fails seven conditions rather than five.
      "dias_atraso_zero",
      "cartera_vencida_false",
    ]);
    // Every one of them failed because its data was unread, not because the
    // applicant missed a bound — which is what ops has to be able to tell apart.
    for (const name of failed) {
      expect(conditionByName(conditions, name).source).toBe("assumed");
    }
  });

  it("fails 11 of 12 closed on all-null input, with no_competitor_loans the sole pass", () => {
    // ADR-005 Finding 8's acceptance criterion, translated from the skipped
    // spec's flat params (stage3-autoapprove.test.js:253-269) to this gate's
    // signature: nothing read, anywhere.
    //
    // no_competitor_loans is the one legitimate pass. Every other condition
    // tests a bound on a value that has to be obtained, so its absence is
    // ignorance; this one tests the absence of a finding in an account list,
    // and with no bureau block there is no account list to hold one. It is
    // safe rather than merely convenient: bureau_score, no_active_defaults,
    // dias_atraso_zero and cartera_vencida_false read the same missing block
    // and all fail, and all twelve must hold, so this pass can never be the
    // margin between an outage and an approval.
    const conditions = evaluateAutoApprove({}, {});

    expect(conditions).toHaveLength(12);
    const passed = conditions.filter((c) => c.pass);
    expect(passed.map((c) => c.name)).toEqual(["no_competitor_loans"]);
    expect(conditions.filter((c) => !c.pass)).toHaveLength(11);
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

// ADR-005 Finding 6: every condition carries a stable numeric id alongside
// its name. Denial reasons derived from these conditions reach borrowers and
// have to stay referenceable across a rename (CONDUSEF).
describe("evaluateAutoApprove — condition ids (ADR-005 Finding 6)", () => {
  it("assigns every condition a unique id from 1 to 12, in order", () => {
    const conditions = evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT);
    expect(conditions.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps ids pinned to today's names, so a future rename doesn't move them", () => {
    const conditions = evaluateAutoApprove(APPLICANT, ALL_DATA_PRESENT);
    const idsByName = Object.fromEntries(conditions.map((c) => [c.name, c.id]));
    expect(idsByName).toEqual({
      employer_tier: 1,
      imss_tenure: 2,
      bureau_score: 3,
      lti: 4,
      no_competitor_loans: 5,
      riskseal_score: 6,
      sector_safe: 7,
      ml_default_prob: 8,
      no_active_defaults: 9,
      age_range: 10,
      dias_atraso_zero: 11,
      cartera_vencida_false: 12,
    });
  });

  it("keeps ids stable regardless of which conditions pass or fail", () => {
    const conditions = evaluateAutoApprove({}, {});
    expect(conditions.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

// ADR-005 Finding 5: the P(default) cutoff is a single declared MAX_PDEFAULT,
// not a derived complement of APPROVAL_THRESHOLD, and it is server-side
// configurable through the SAME seam ADR-002 established for the fee rate
// (config/maxPDefaultCutoff.js). `evaluateAutoApprove` stays synchronous and
// takes the resolved cutoff as its third argument — these tests cover that
// parameter directly. `runAutoApproveGate` (below) covers the Firestore read
// that resolves it in production.
describe("ml_default_prob condition — MAX_PDEFAULT (ADR-005 Finding 5)", () => {
  function dataWithPDefault(pDefault) {
    return {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: { ...ALL_DATA_PRESENT.stage2.data, mlScore: { championScore: 1 - pDefault } },
      },
    };
  }

  it("defaults to the seed cutoff of 0.15 when no cutoff is supplied — the value ADR-006 ratified, superseding 0.35", () => {
    expect(SEED_MAX_PDEFAULT).toBe(0.15);

    const passing = evaluateAutoApprove(APPLICANT, dataWithPDefault(0.14))
      .find((c) => c.name === "ml_default_prob");
    const failing = evaluateAutoApprove(APPLICANT, dataWithPDefault(0.15))
      .find((c) => c.name === "ml_default_prob");

    expect(passing.pass).toBe(true);
    expect(passing.required).toBe("< 0.15");
    expect(failing.pass).toBe(false);

    // The bound is strict (`<`), so the cutoff value itself declines. Pinned
    // because ADR-006 halved the cutoff: an off-by-one at the boundary is a
    // credit-policy error, not a rounding detail.
    const atOldCutoff = evaluateAutoApprove(APPLICANT, dataWithPDefault(0.34))
      .find((c) => c.name === "ml_default_prob");
    expect(atOldCutoff.pass).toBe(false);
  });

  it("honours an explicit cutoff over the seed", () => {
    const cond = evaluateAutoApprove(APPLICANT, dataWithPDefault(0.20), 0.15)
      .find((c) => c.name === "ml_default_prob");
    expect(cond.pass).toBe(false);
    expect(cond.required).toBe("< 0.15");
  });

  it("an explicit cutoff can also loosen the gate relative to the seed", () => {
    const cond = evaluateAutoApprove(APPLICANT, dataWithPDefault(0.4), 0.5)
      .find((c) => c.name === "ml_default_prob");
    expect(cond.pass).toBe(true);
    expect(cond.required).toBe("< 0.5");
  });

  // ADR-005 Finding 5: "the condition reads the CHAMPION model. The
  // challenger is scored and logged in parallel, per ADR-001; promoting it
  // is a separate ratified event, not a fixture choice." `stage2Data.mlScore`
  // carries no champion/challenger split — it IS the champion score — so
  // this pins that a `shadow: true` challenger value sitting alongside it in
  // the same object is structurally inert: condition 8 does not look at any
  // nested `.challenger` / `.champion` key, so a shadow score can never reach
  // `pDefault` no matter what else the ML service response carries.
  it("never reads a shadow-marked challenger value, even when one is present on the same object", () => {
    const withShadowChallenger = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          // The real response carries champion and challenger as SIBLING keys,
          // not a nested `challenger` object. That makes this the sharper test:
          // `challengerScore` sits one line from the right field, and reading it
          // would approve (P(default) 0.01) an applicant the champion declines.
          mlScore: {
            championScore: 0.82, // P(repayment) → P(default) 0.18, declines
            challengerScore: 0.99, // shadow only, never obeyed (ADR-001)
          },
        },
      },
    };

    const cond = evaluateAutoApprove(APPLICANT, withShadowChallenger)
      .find((c) => c.name === "ml_default_prob");

    // Under ADR-006's 0.15 cutoff this assertion discriminates in a way it
    // could not before: the champion's 0.18 DECLINES while the shadow
    // challenger's 0.01 would pass. So `pass === false` is now itself proof
    // the challenger was not read — previously both values cleared the 0.35
    // seed and only the pinned `value` carried the argument.
    expect(cond.value).toBe(0.18);
    expect(cond.pass).toBe(false);
  });
});

// These pin the WIRE CONTRACT rather than the gate's arithmetic, because the
// contract is where this condition actually broke. Condition 8 read
// `default_probability || probability || (1 - underwritingScore)`; the ML
// service has never sent any of the three, so every applicant fell through to
// a hardcoded `1 - 0.5 = 0.5` and no application could clear any cutoff below
// 0.5 — condition 8 failed for 100% of applicants, in production, silently.
//
// The whole suite stayed green throughout, because every fixture in it mocked
// the same three fields the gate was reading. Tests and code agreed with each
// other and both disagreed with the service. So a test that feeds this gate a
// hand-built object proves very little; what follows deliberately asserts
// against the shape `ml-service/main.py:485-494` really returns.
describe("ml_default_prob condition — the ML /score wire contract", () => {
  function withMlScore(mlScore) {
    return {
      ...ALL_DATA_PRESENT,
      stage2: { data: { ...ALL_DATA_PRESENT.stage2.data, mlScore } },
    };
  }

  const condFrom = (data) =>
    evaluateAutoApprove(APPLICANT, data).find((c) => c.name === "ml_default_prob");

  it("derives P(default) from championScore alone, on the exact shape /score returns", () => {
    // Verbatim response shape from ml-service/main.py:485-494 — every key, no
    // P(default) field anywhere on it, which is the point.
    const cond = condFrom(
      withMlScore({
        decision: "approved",
        championScore: 0.93,
        challengerScore: 0.41,
        threshold: 0.65,
        championModel: "logreg-v3",
        challengerModel: "xgboost-v1",
        shapTop5: [],
      })
    );

    // championScore is P(repayment) (underwriting_model.py:37,
    // xgb_model.py:64), and champion_challenger.py:65 approves on a HIGH
    // score — so P(default) is its complement, not the score itself. Were the
    // polarity inverted, 0.93 would read as a 93% chance of default and this
    // strong applicant would be declined; worse, the genuinely risky
    // applicants would be the ones auto-approved.
    expect(cond.value).toBe(0.07);
    expect(cond.pass).toBe(true);
  });

  it("fails closed on a response carrying only the fields the gate used to read", () => {
    // The regression itself. This object is what every fixture in this repo
    // used to assert against; the service has never produced it. It must now
    // fail closed rather than quietly resolve to 0.5 or to 0.05.
    const cond = condFrom(
      withMlScore({ default_probability: 0.05, probability: 0.05, underwritingScore: 0.95 })
    );

    expect(cond.value).toBeNull();
    expect(cond.pass).toBe(false);
  });

  it("treats championScore 0 as the worst borrower, not as a missing value", () => {
    // A championScore of exactly 0 is P(repayment) 0 — certain default — and
    // it is also falsy. Under a `||` chain it is swallowed by the fallback and
    // reappears as a neutral 0.5 (or, before, as any default at all), turning
    // the single worst applicant the model can describe into an average one.
    const cond = condFrom(withMlScore({ championScore: 0 }));

    expect(cond.value).toBe(1);
    expect(cond.pass).toBe(false);
  });

  it("passes a championScore of exactly 1 through as P(default) 0", () => {
    // The opposite bound, included so the `??` guard cannot be satisfied by
    // something that merely special-cases zero.
    const cond = condFrom(withMlScore({ championScore: 1 }));

    expect(cond.value).toBe(0);
    expect(cond.pass).toBe(true);
  });

  it.each([
    ["a string score", { championScore: "0.93" }],
    ["an explicit null", { championScore: null }],
    ["NaN", { championScore: Number.NaN }],
    ["a response with no score at all", { decision: "approved" }],
  ])("fails closed on %s", (_label, mlScore) => {
    // A malformed response is not a low-risk applicant. Note `source` is still
    // "read" for all of these — the ML call succeeded and returned something —
    // so the existing provenance guard does not cover this case and the null
    // check in deriveDefaultProbability is what fails it closed.
    const cond = condFrom(withMlScore(mlScore));

    expect(cond.source).toBe("read");
    expect(cond.value).toBeNull();
    expect(cond.pass).toBe(false);
  });

  it("does not let a null P(default) compare its way past the cutoff", () => {
    // Guarding the arithmetic, not just the value: `null < 0.15` is true in
    // JavaScript, so a null that reached the comparison unguarded would
    // AUTO-APPROVE every malformed response — a strictly worse failure than
    // the one being fixed, and the reason `pass` tests `!== null` explicitly.
    expect(null < 0.15).toBe(true);
    expect(condFrom(withMlScore({ championScore: null })).pass).toBe(false);
  });
});

// ADR-005 Finding 5's server-side config seam, exercised end to end through
// runAutoApproveGate (the function decision-engine.js actually awaits),
// mirroring how competitorLenders.test.js exercises getCompetitorLenderNames.
describe("runAutoApproveGate — MAX_PDEFAULT config seam (ADR-005 Finding 5)", () => {
  beforeEach(() => {
    mockMaxPDefaultConfigGet.mockReset();
  });

  const silentLogger = { info: () => {}, error: () => {}, warn: () => {} };

  it("uses the seed (0.15) when the config document does not exist", async () => {
    mockMaxPDefaultConfigGet.mockResolvedValue({ exists: false });

    const dataAtSeedBoundary = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: { ...ALL_DATA_PRESENT.stage2.data, mlScore: { championScore: 0.86 } },
      },
    };

    const result = await runAutoApproveGate(APPLICANT, dataAtSeedBoundary, { logger: silentLogger });
    const cond = result.data.conditions.find((c) => c.name === "ml_default_prob");
    expect(cond.required).toBe("< 0.15");
    expect(result.pass).toBe(true);
  });

  it("uses the configured value when the document is valid", async () => {
    mockMaxPDefaultConfigGet.mockResolvedValue({ exists: true, data: () => ({ value: 0.15 }) });

    const dataAt020 = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: { ...ALL_DATA_PRESENT.stage2.data, mlScore: { championScore: 0.80 } },
      },
    };

    const result = await runAutoApproveGate(APPLICANT, dataAt020, { logger: silentLogger });
    const cond = result.data.conditions.find((c) => c.name === "ml_default_prob");
    expect(cond.required).toBe("< 0.15");
    expect(cond.pass).toBe(false);
  });

  it("fails closed (rejects, does not fall back to the seed) when the config document exists but cannot be trusted", async () => {
    mockMaxPDefaultConfigGet.mockResolvedValue({ exists: true, data: () => ({ value: "not-a-number" }) });

    await expect(
      runAutoApproveGate(APPLICANT, ALL_DATA_PRESENT, { logger: silentLogger })
    ).rejects.toThrow("MAX_PDEFAULT config");
  });

  it("fails closed when the config read itself fails", async () => {
    mockMaxPDefaultConfigGet.mockRejectedValue(new Error("network down"));

    await expect(
      runAutoApproveGate(APPLICANT, ALL_DATA_PRESENT, { logger: silentLogger })
    ).rejects.toThrow("MAX_PDEFAULT config");
  });
});

// ADR-005 C5 — ratified by founder (Isaac), 2026-08-03: a competitor loan
// does not hard-decline an applicant. It blocks auto-approval only, exactly
// like every other failed Stage 3 condition — a failing `no_competitor_loans`
// sets `escalateToStage` to a review stage (4 or 5) the same as any other
// failure would, and `runAutoApproveGate` never returns a decline itself.
// `decision-engine.js` only rejects on Stage 3's behalf when `escalateToStage`
// is neither 4 nor 5 — a branch this function never takes, since every
// non-passing path below ends by setting one of the two. Which lenders count
// toward `competitorLoans` remains open (ADR-005 C5, second half) and is
// untouched here.
describe("runAutoApproveGate — competitor loan routing (ADR-005 C5, ratified 2026-08-03)", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // These cases are about ROUTING, not about the cutoff, so they run against
  // an unconfigured deployment: no config document, therefore the
  // compile-time seed. That is the cutoff the fixtures below were written
  // against — ALL_DATA_PRESENT's P(default) of 0.18 clears it, leaving
  // `no_competitor_loans` as the single failing condition the first case
  // asserts on. Without this, `getMaxPDefault()` reads an unstubbed mock and
  // the gate throws before it can route anything.
  beforeEach(() => {
    mockMaxPDefaultConfigGet.mockReset();
    mockMaxPDefaultConfigGet.mockResolvedValue({ exists: false });
  });

  it("does not decline on a competitor-loan-only failure; it escalates to further review instead", async () => {
    const competitorLoanOnly = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          bureau: { ...ALL_DATA_PRESENT.stage2.data.bureau, competitorLoans: 1, competitorLoansByName: 1 },
        },
      },
    };

    const result = await runAutoApproveGate(APPLICANT, competitorLoanOnly, { logger });

    expect(result.pass).toBe(false);
    expect(result.data.failedConditions.map((c) => c.name)).toEqual(["no_competitor_loans"]);

    // The invariant C5 ratifies: no direct decline. escalateToStage is
    // always a review stage, never null/undefined, when the gate fails.
    expect([4, 5]).toContain(result.escalateToStage);
    expect(result.reason).not.toMatch(/DECLIN|REJECT/i);

    // Pinned to today's routing shape: a clean applicant (no active
    // defaults, healthy bureau score, principal under the Stage 4 trigger)
    // whose sole failure is the competitor-loan condition falls to the
    // gate's default branch — Stage 4, full KYC — not a decline.
    expect(result.escalateToStage).toBe(4);
    expect(result.reason).toBe("AUTO_APPROVE_FAILED");
  });

  it("still escalates rather than declines when a competitor loan combines with a low bureau score", async () => {
    const competitorLoanAndLowScore = {
      ...ALL_DATA_PRESENT,
      stage2: {
        data: {
          ...ALL_DATA_PRESENT.stage2.data,
          bureau: { ...ALL_DATA_PRESENT.stage2.data.bureau, score: 350, competitorLoans: 1, competitorLoansByName: 1 },
        },
      },
    };

    const result = await runAutoApproveGate(APPLICANT, competitorLoanAndLowScore, { logger });

    expect(result.pass).toBe(false);
    // bureauScore < 400 routes to Stage 5 regardless of which conditions
    // failed to get there — still an escalation, never a decline.
    expect(result.escalateToStage).toBe(5);
    expect(result.reason).toBe("MANUAL_REVIEW_REQUIRED");
  });
});
