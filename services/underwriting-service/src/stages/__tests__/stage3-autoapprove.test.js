"use strict";

// ════════════════════════════════════════════════════════════════════
// RATIFIED AND EXECUTABLE — ADR-006 (2026-08-03). See #387.
//
// This file was 100% `describe.skip` from #457 until now: every policy
// disagreement recorded below was real, and none of them were engineering's
// to settle. ADR-006 closed them. What was left once it did was an
// API-shape gap — this spec always destructured `runStage3`, `evaluateGate`,
// `hasCompetitorLoans`, and `../stage3-autoapprove` never exported them —
// which was never the open question. `evaluateGate`/`runStage3` are thin
// adapters over `evaluateAutoApprove`, and `hasCompetitorLoans` is
// re-exported from `config/competitorLenders.js` verbatim: there remains
// exactly one place a condition's pass/fail is decided.
//
// Three disagreements below are now resolved, and one is not — read on:
//
//   - Competitor detection: RATIFIED per ADR-006 §3. Named matching against
//     the admin-editable KUESKI/MoneyMan/CREDITEA list, exactly as specced.
//   - The condition set: RATIFIED per ADR-006 §2 — the gate goes from ten
//     conditions to TWELVE. `no_active_defaults` (9) and `age_range` (10)
//     stay LIVE (their retirement was drafted, then withdrawn as
//     unratified — see ADR-006), and `dias_atraso_zero` /
//     `cartera_vencida_false` are ADDED, not substituted. This spec
//     originally numbered the new pair (plus xgboost/ml P(default)) as
//     8/9/10. The implementation keeps `ml_default_prob` at id 8 — its
//     assigned id since before this file existed — and takes 11/12 for the
//     new pair, under an id-permanence rule: ids are persisted onto loan
//     documents (`functions/src/index.ts:625-638`), so recycling one would
//     silently rewrite the meaning of records already written. Every id
//     asserted below has been renumbered to match (8→11 dias_atraso_zero,
//     9→12 cartera_vencida_false, 10→8 the P(default) condition, renamed
//     from `xgboost_pdefault` to the shipped `ml_default_prob` — see the
//     next point for why "xgboost" was never accurate anyway). `age_range`
//     keeps id 10 and `no_active_defaults` keeps id 9, unchanged, because
//     ADR-006 kept both live.
//   - The P(default) cutoff: RATIFIED at 0.15 per ADR-006 §1 — the number
//     this spec always carried.
//   - The model source is NOT ratified the way this file originally
//     assumed, and this is the one place the spec and shipped policy stay
//     in conflict: `runStage3`'s "pulls xgboostPDefault from challenger
//     model" (below) requires reading `challenger: {..., shadow: true}`.
//     ADR-001 §Decision.2 is explicit that shadow output is "logged, not
//     obeyed", and ADR-005 Finding 5 / ADR-006's shipped implementation
//     read the CHAMPION model only, precisely to avoid promoting a shadow
//     model into a live gate by fixture accident. That test cannot be made
//     to pass without either (a) violating the ratified champion-only rule,
//     or (b) fabricating a second code path that reads the challenger,
//     which would be a second, driftable place a condition is decided —
//     exactly what this file exists to prevent. It is left `it.skip` with
//     this explanation rather than deleted, weakened, or silently fixed;
//     promoting the challenger is ADR-001's "separate ratified event," and
//     none has happened.
//
// LTI units were already resolved before this pass (ADR-005 Finding 4,
// engineering shape, shipped in #465): percentage wins end to end. No
// change needed here.
//
// `ALL_PASS_PARAMS` and `STAGE2_RESULT` predate conditions 9 (no_active_
// defaults) and 10 (age_range) and carried no `age` / `activeDefaults`
// input, so neither fixture could pass a twelve-condition gate as written.
// Both gained the missing fields below so each fixture means what its name
// says — this is completion, not a loosened assertion.
//
// DO NOT make this green by weakening the assertions to match the
// current source, and do not delete it: it is the only surviving
// record of the intended auto-approve gate.
// ════════════════════════════════════════════════════════════════════

const {
  runStage3,
  evaluateGate,
  hasCompetitorLoans,
} = require("../stage3-autoapprove");

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALL_PASS_PARAMS = {
  employerTier: 1,
  tenureMonths: 12,
  bureauScore: 700,
  lti: 20, // percentage (ADR-005 Finding 4) — was 0.20 (a fraction), which disagreed with the shipped producer
  cuentasActivas: [],
  riskSealScore: 75,
  sectorFlagged: false,
  diasAtraso: 0,
  carteraVencida: false,
  xgboostPDefault: 0.05,
  // Added for ADR-006's twelve-condition gate (conditions 9 and 10) — this
  // fixture predates both and could not otherwise mean "all pass".
  age: 30,
  activeDefaults: 0,
};

const STAGE2_RESULT = {
  bureau: {
    score: 700,
    diasAtraso: 0,
    carteraVencida: false,
    cuentasActivas: 2,
    // Added alongside `age` below for ADR-006's condition 9 — see the note
    // on ALL_PASS_PARAMS.
    activeDefaults: 0,
  },
  employment: {
    tenureMonths: 12,
  },
  // { value } percentage, matching the shape and units stage2-bureau.js's
  // computeLTI actually produces (ADR-005 Finding 4) — was a bare fraction.
  lti: { value: 20 },
  // Added for ADR-006's condition 10 (age_range) — this fixture predates it.
  age: 30,
  ml: {
    champion: { pDefault: 0.05, model: "woe_scorecard" },
    challenger: { pDefault: 0.08, model: "xgboost", shadow: true },
  },
};

// ── hasCompetitorLoans ──────────────────────────────────────────────────────

describe("hasCompetitorLoans", () => {
  it("returns false for empty or null accounts", () => {
    expect(hasCompetitorLoans(null)).toBe(false);
    expect(hasCompetitorLoans([])).toBe(false);
  });

  it("returns false when no competitors present", () => {
    const accounts = [
      { otorgante: "BANCOMER" },
      { otorgante: "BANAMEX" },
    ];
    expect(hasCompetitorLoans(accounts)).toBe(false);
  });

  it("detects Kueski as competitor", () => {
    const accounts = [{ otorgante: "KUESKI PAY SA DE CV" }];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });

  it("detects MoneyMan as competitor (case insensitive)", () => {
    const accounts = [{ nombreOtorgante: "MoneyMan Mexico" }];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });

  it("detects multiple competitor keywords", () => {
    const accounts = [
      { otorgante: "BANCOMER" },
      { otorgante: "CREDITEA MX" },
    ];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });
});

// ── evaluateGate ────────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  it("approves when all 12 conditions pass", () => {
    const result = evaluateGate(ALL_PASS_PARAMS);
    expect(result.decision).toBe("approved");
    expect(result.allPass).toBe(true);
    // 12, not 10 — ADR-006 §2 adds dias_atraso_zero and cartera_vencida_false
    // (ids 11/12) while keeping no_active_defaults (9) and age_range (10)
    // live; the gate went from ten conditions to twelve, not a substitution.
    expect(result.conditionsPassed).toBe(12);
    expect(result.conditionsTotal).toBe(12);
    expect(result.failures).toHaveLength(0);
    expect(result.escalateToStage).toBeNull();
  });

  it("escalates to stage 4 when any condition fails", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, bureauScore: 500 });
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(4);
    expect(result.allPass).toBe(false);
  });

  // ── Individual condition failures ───────────────────────────────────────

  it("fails condition 1: employer tier 3", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, employerTier: 3 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 1);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("employer_tier");
  });

  it("fails condition 2: tenure <= 6 months", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, tenureMonths: 6 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 2);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("imss_tenure");
  });

  it("fails condition 3: bureau score <= 600", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, bureauScore: 600 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 3);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("bureau_score");
  });

  it("fails condition 4: LTI > 25%", () => {
    // 26, not 0.26 — percentage (ADR-005 Finding 4): the fraction disagreed
    // with the shipped producer, computeLTI, and with the one green test
    // (decision-engine.test.js) that already asserts a percentage value.
    const result = evaluateGate({ ...ALL_PASS_PARAMS, lti: 26 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 4);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("lti");
  });

  it("passes condition 4: LTI exactly 25%", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, lti: 25 });
    const cond = result.conditions.find(c => c.id === 4);
    expect(cond.pass).toBe(true);
  });

  it("fails condition 5: competitor loans found", () => {
    const accounts = [{ otorgante: "KUESKI PAY" }];
    const result = evaluateGate({ ...ALL_PASS_PARAMS, cuentasActivas: accounts });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 5);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("no_competitor_loans");
  });

  it("fails condition 6: RiskSeal score <= 60", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, riskSealScore: 60 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 6);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("riskseal_score");
  });

  it("fails condition 7: sector flagged", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, sectorFlagged: true });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 7);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("sector_safe");
  });

  // Renumbered 8 -> 11 (id permanence — see the file banner above): this
  // spec originally numbered the added días-de-atraso condition 8, but the
  // implementation's id 8 was already `ml_default_prob`'s before this file
  // existed, so the addition takes the next free id instead.
  it("fails condition 11: diasAtraso > 0", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, diasAtraso: 1 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 11);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("dias_atraso_zero");
  });

  // Renumbered 9 -> 12 — same id-permanence reasoning as condition 11 above;
  // id 9 stays `no_active_defaults`, which ADR-006 kept live.
  it("fails condition 12: carteraVencida true", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, carteraVencida: true });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 12);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("cartera_vencida_false");
  });

  // Renumbered 10 -> 8, and renamed from `xgboost_pdefault` to the shipped
  // `ml_default_prob`: id 8 was already assigned to this condition before
  // this file existed (id permanence), and id 10 stays `age_range`, which
  // ADR-006 kept live rather than retiring in favour of this one.
  // "xgboost" was also never accurate as a name — ADR-005 Finding 5 already
  // recommended a vendor-neutral name, since a model swap would otherwise
  // falsify a borrower-facing denial-reason id.
  it("fails condition 8: ML P(default) >= threshold", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, xgboostPDefault: 0.20 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 8);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("ml_default_prob");
  });

  it("fails condition 8: ML P(default) is null", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, xgboostPDefault: null });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 8);
    expect(failure).toBeDefined();
  });

  it("reports multiple failures", () => {
    const result = evaluateGate({
      ...ALL_PASS_PARAMS,
      employerTier: 3,
      bureauScore: 400,
      diasAtraso: 5,
    });
    expect(result.allPass).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    expect(result.conditionsPassed).toBeLessThan(12);
  });

  it("handles null values safely", () => {
    const result = evaluateGate({
      employerTier: null,
      tenureMonths: null,
      bureauScore: null,
      lti: null,
      cuentasActivas: null,
      riskSealScore: null,
      sectorFlagged: null,
      diasAtraso: null,
      carteraVencida: null,
      xgboostPDefault: null,
      age: null,
      activeDefaults: null,
    });
    expect(result.allPass).toBe(false);
    // Only condition 5 (no_competitor_loans) passes with null cuentasActivas
    // — re-derived for twelve conditions: 12 total - 1 pass (condition 5,
    // the sole documented exception to fail-closed, per stage3-autoapprove.js
    // condition 5's comment) = 11 failures. The old assertion here was 9,
    // correct for the old ten-condition gate (10 - 1); this is a fresh
    // derivation off the new total, not "the old number plus 2".
    expect(result.failures.length).toBe(11);
  });
});

// ── runStage3 ───────────────────────────────────────────────────────────────

describe("runStage3", () => {
  it("approves when stage2 result + lookups all pass", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
      cuentasActivasDetail: [],
    });
    expect(result.decision).toBe("approved");
    expect(result.allPass).toBe(true);
  });

  it("escalates when stage2 bureau score too low", () => {
    const result = runStage3({
      stage2Result: {
        ...STAGE2_RESULT,
        bureau: { ...STAGE2_RESULT.bureau, score: 550 },
      },
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(4);
  });

  // NOT ratified, and cannot be reconciled without either breaking the
  // champion-only rule or forking condition 8's decision into a second code
  // path — see the file banner's "model source" paragraph. ADR-001
  // §Decision.2 ("logged, not obeyed") and ADR-005 Finding 5 / ADR-006's
  // shipped implementation are unambiguous that a `shadow: true` model
  // never gates a live decision; promoting it is "a separate ratified
  // event, not a fixture choice" (Finding 5), and no such event has
  // happened. Left skipped rather than deleted or weakened — this is the
  // one open contradiction this pass could not close.
  it.skip("pulls xgboostPDefault from challenger model — NOT RATIFIED, see banner", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    // xgboostPDefault = 0.08 from challenger, < 0.15 threshold
    const cond8 = result.conditions.find(c => c.id === 8);
    expect(cond8.value).toBe(0.08);
    expect(cond8.pass).toBe(true);
  });

  it("fails when employer tier is missing from stage2", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 3,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    expect(result.allPass).toBe(false);
    expect(result.failures.some(f => f.name === "employer_tier")).toBe(true);
  });
});
