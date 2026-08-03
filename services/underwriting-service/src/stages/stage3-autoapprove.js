"use strict";
/**
 * Stage 3: Auto-Approve Gate
 *
 * 12 conditions ALL must pass:
 *   1. Employer tier >= 1 (not rejected)
 *   2. IMSS tenure > 6 months
 *   3. Bureau score > 600
 *   4. LTI <= 25%
 *   5. No competitor loans (named-match against the admin-editable list)
 *   6. RiskSeal > 60
 *   7. Sector safe (CNBV not "alto")
 *   8. ML P(default) < MAX_PDEFAULT (champion model only)
 *   9. No active defaults
 *  10. Age 18-65 (already validated in Stage 1, re-checked here)
 *  11. Bureau días de atraso == 0
 *  12. Bureau cartera vencida == false
 *
 * ADR-006 (2026-08-03) added ids 11 and 12 and left 9 and 10 in place. A
 * draft of that ADR proposed retiring 9 and 10; retiring them would loosen
 * the gate, which is a commercial change, so it stays an open question for
 * Isaac and the gate only tightens for now. See RETIRED_CONDITION_IDS.
 *
 * Every condition fails closed on data the pipeline never read (#458). A
 * condition passes only when its `source` is "read" AND its bound holds; an
 * "assumed" value can no longer clear a condition, so a provider outage
 * escalates to human review instead of quietly auto-approving. The single
 * documented exception is `no_competitor_loans` — see condition 5.
 */

// ADR-005 Finding 5: the cutoff used to be derived — `APPROVAL_THRESHOLD`
// (default 0.65), read as `pDefault < (1 - threshold)` — so raising something
// named "approval threshold" *loosened* credit. It is now declared directly
// as MAX_PDEFAULT, and it is server-side configurable through the SAME seam
// ADR-002 established for the loan fee rate and Finding 7's competitor list:
// a compile-time seed (config/maxPDefaultCutoff.js's `getSeedMaxPDefault`),
// used until an admin config document exists, and a read path
// (`getMaxPDefault`) that throws — rather than silently falling back to the
// seed — when that document exists but cannot be trusted. Value is
// RATIFIED by ADR-006 (2026-08-03) at 0.15, superseding the 0.35 this
// condition read before — see config/maxPDefaultCutoff.js.
const { getMaxPDefault, getSeedMaxPDefault } = require("../config/maxPDefaultCutoff");

/**
 * Provenance for a condition's value: "read" if the upstream block that
 * computes it ran and did not mark itself `skipped: true`, "assumed"
 * otherwise — the block was never reached (stage error, stage2Data.{} on a
 * whole-stage failure) or it ran and gave up (stage2-bureau.js:183-189 and
 * the IMSS/AFORE/ML blocks). Modelled on `payFrequencySource` (#433): a
 * value the pipeline never read must not be shown with the same confidence
 * as one it did (#458).
 *
 * #459 made this visible; it now decides. Every condition below reads
 * `pass: <source> === "read" && <bound>`, so a value the pipeline never read
 * cannot clear a bound — the gate refuses rather than approves blind
 * (decision-engine.js:66-72, ADR-005 Findings 3 and 8).
 */
function provenanceOf(block) {
  return block && block.skipped !== true ? "read" : "assumed";
}

/**
 * Convert an ML `/score` response into P(default), or `null` if it cannot be
 * derived.
 *
 * THE WIRE CONTRACT, as it actually is (ml-service/main.py:485-494):
 *   { decision, championScore, challengerScore, threshold,
 *     championModel, challengerModel, shapTop5 }
 *
 * `championScore` is **P(repayment)** — higher is a SAFER borrower — so
 * P(default) is its complement. Three primary sources agree, and the polarity
 * matters more than the field name: inverting it would auto-approve precisely
 * the applicants who should escalate.
 *   - models/underwriting_model.py:37  "Return P(repayment) in [0.0, 1.0].
 *     Higher = safer borrower."
 *   - models/xgb_model.py:64           "Return calibrated P(repayment)."
 *   - models/champion_challenger.py:65 `decision = "approved" if
 *     champion_score >= threshold` — it approves on a HIGH score.
 *
 * This previously read `default_probability || probability ||
 * (1 - underwritingScore)`. No ML response has ever carried any of those three
 * fields, so every applicant silently fell through to `1 - 0.5 = 0.5` and no
 * application could clear any cutoff below 0.5 — condition 8 failed for 100%
 * of applicants. `underwritingScore` is real, but it is the key the async
 * worker writes to Firestore (workers/underwriting_worker.py:383), never a key
 * of the synchronous `/score` response this gate reads.
 *
 * `??`, not `||`: a championScore of exactly 0 is the worst possible borrower
 * (P(default) 1.0) and is falsy. `||` would swallow it into the neutral 0.5 —
 * the same class of defect this function exists to fix.
 *
 * Returns `null` on a malformed-but-present response so the caller fails
 * CLOSED. A score we could not parse is not a score we can approve on.
 */
function deriveDefaultProbability(mlScore) {
  const champion = mlScore?.championScore ?? null;
  if (typeof champion !== "number" || !Number.isFinite(champion)) return null;
  // Rounded to 4dp, matching the precision the ML service itself emits
  // (champion_challenger.py:85 `round(champion_score, 4)`). Without this the
  // complement carries binary-float noise — `1 - 0.88` is 0.12000000000000001 —
  // into a value that is persisted on the loan and shown to admins as the
  // reason a decision went the way it did.
  return Math.round((1 - champion) * 1e4) / 1e4;
}

// ADR-005 Finding 6: stable numeric ids, alongside the names, for every
// condition below. Denial reasons derived from these conditions reach
// borrowers, and under the CONDUSEF regime a reason has to stay referenceable
// across a rename. Treat an id as permanent identity once assigned: never
// renumber or reassign an id to a different condition, even if the condition
// at that slot is later replaced (ADR-005 C4 governs which conditions
// gate — not this file). If a condition is retired, retire its id with it
// rather than recycling the number.
//
// `maxPDefaultCutoff` is resolved by the caller (`runAutoApproveGate`, via
// `getMaxPDefault()`) so this function stays synchronous and testable
// without a Firestore mock in every call site. Callers that omit it — every
// existing direct test of this function — get the compile-time seed, which
// is exactly today's shipped value, so omitting it changes no behaviour.
//
// RETIRED CONDITION IDS — none today, and the list is deliberately empty.
// A draft of ADR-006 proposed retiring id 9 (`no_active_defaults`) as
// subsumed by the bureau's own días-de-atraso/cartera-vencida fields, and
// id 10 (`age_range`) as a redundant re-check of a bound Stage 1 already
// validates. Both readings are defensible, but retiring a condition loosens
// the auto-approve gate, and no such loosening has been ratified — so both
// ids remain LIVE and ADR-006 carries the retirement as an open question.
// The two conditions ADR-006 does add take the next unused ids, 11 and 12.
// When a retirement is eventually ratified, record the id here; a retired
// id's number is never reassigned.
const RETIRED_CONDITION_IDS = Object.freeze({});

function evaluateAutoApprove(applicant, allResults, maxPDefaultCutoff = getSeedMaxPDefault()) {
  const conditions = [];
  const employerData = allResults.employerB?.data || {};
  const stage0Data = allResults.stage0?.data || {};
  const stage1Data = allResults.stage1?.data || {};
  const stage2Data = allResults.stage2?.data || {};

  // 1. Employer tier >= 1
  //
  // No `||` fallback chain (ADR-005 Finding 3). `||` cannot tell an absent tier
  // from a zero one, and `applicant.employerTier` is caller-supplied — the same
  // "trust the caller's shaping" pattern decision-engine.js:62-64 already
  // rejects for the principal. A stale `employerTier: 1` on the applicant must
  // not stand in for a tier employer Part B never returned. The tier comes from
  // the pipeline or the condition fails closed.
  //
  // Rejected employers stay encoded as tier 3 (employer-b.js:75), which fails
  // the upper bound on its own. The `||` chain used to catch a falsy tier and
  // land on the literal 3 by accident, and that accident is gone — so the
  // bound is stated at both ends rather than left resting on today's encoding.
  // employer-b only ever emits 1, 2 or 3, so `>= 1` changes no live decision;
  // it means that if employer-b ever adopts the spec's tier 0 for rejected
  // (ADR-005 Finding 3 says it should not), this condition declines instead of
  // approving workers at a rejected employer. Fails closed in both directions.
  const employerTierSource = employerData.tier != null ? "read" : "assumed";
  const employerTier = employerData.tier ?? null;
  conditions.push({
    id: 1,
    name: "employer_tier",
    pass: employerTierSource === "read" && employerTier >= 1 && employerTier <= 2,
    value: employerTier,
    required: "1-2",
    source: employerTierSource,
  });

  // 2. IMSS tenure > 6 months
  const imssSource = provenanceOf(stage2Data.imss);
  const tenure = stage2Data.imss?.tenureMonths || applicant.employmentTenureMonths || 0;
  conditions.push({
    id: 2,
    name: "imss_tenure",
    pass: imssSource === "read" && tenure > 6,
    value: tenure,
    required: "> 6 months",
    source: imssSource,
  });

  // 3. Bureau score > 600
  const bureauSource = provenanceOf(stage2Data.bureau);
  const bureauScore = stage2Data.bureau?.score || 500;
  conditions.push({
    id: 3,
    name: "bureau_score",
    pass: bureauSource === "read" && bureauScore > 600,
    value: bureauScore,
    required: "> 600",
    source: bureauSource,
  });

  // 4. LTI <= 25%
  //
  // The fallback is 0 and `0 <= 25` always passes — the exact hazard
  // decision-engine.js:67-73 names for a missing principal. A stage 2 that
  // never produced an LTI now fails here instead of clearing affordability.
  const ltiSource = provenanceOf(stage2Data.lti);
  const lti = stage2Data.lti?.value || 0;
  conditions.push({
    id: 4,
    name: "lti",
    pass: ltiSource === "read" && lti <= 25,
    value: lti,
    required: "<= 25%",
    source: ltiSource,
  });

  // 5. No competitor loans — wired to the named-match signal
  //    (`competitorLoansByName`, config/competitorLenders.js +
  //    stage2-bureau.js) rather than the opaque SoftCrédito count, per
  //    ADR-005 C5 (competitor loan blocks auto-approval only, ratified) and
  //    ADR-006 (2026-08-03, the seeded list — KUESKI/MoneyMan/CREDITEA —
  //    ratified as-is). The condition's EFFECT is unchanged by this rewiring:
  //    a failure here still only escalates, never declines (C5). Only which
  //    signal decides the count changed.
  //
  //    This is still the one condition allowed to pass on a value the
  //    pipeline did not read, and only in one shape.
  //
  //    Every other condition tests a bound on a value we have to *obtain* — a
  //    score, a tenure, a tier — so absence of that value is ignorance and must
  //    fail closed. This one tests the absence of a finding in the applicant's
  //    account list. With no bureau block at all there is no account list
  //    either, and "no competitor accounts were found" is then literally true
  //    rather than assumed. It is safe to let that pass, not merely convenient:
  //    bureau_score, no_active_defaults, dias_atraso_zero and
  //    cartera_vencida_false all read the same missing block and all fail
  //    closed, and all twelve conditions must hold, so a missing bureau can
  //    never be the margin between an outage and an approval. ADR-005
  //    Finding 8 fixes this as the acceptance criterion: all-null input
  //    yields 11 failures out of 12, with this the sole legitimate pass.
  //
  //    What must NOT pass is the bureau *error stub* (stage2-bureau.js's
  //    catch block, `skipped: true`) — a bureau block that exists, ran, and
  //    gave up. Nor may a bureau block that WAS read but whose name-match
  //    could not be computed (config/competitorLenders.js's Firestore doc
  //    unreadable — stage2-bureau.js leaves `competitorLoansByName` unset in
  //    that case rather than fabricating a count). Both are "we tried and
  //    don't know", not "we checked and found nothing", and both fail closed
  //    like every other condition that reads a value it could not obtain.
  //
  //    NOTE on `source`: when the bureau block is absent this condition
  //    reports `source: "assumed"` and still passes. It is tempting to call
  //    it "read" instead — "no account list means no competitor accounts
  //    were found" — which would make the fail-closed invariant universal
  //    with no exception to document. That is rejected deliberately: nothing
  //    was read, and relabelling an absence as a measurement is precisely
  //    the #458 failure this file exists to prevent. The exception stays
  //    visible and narrow rather than being defined away.
  const bureauBlockAbsent = stage2Data.bureau == null;
  const competitorLoansByName = stage2Data.bureau?.competitorLoansByName;
  const competitorSource =
    !bureauBlockAbsent && bureauSource === "read" && competitorLoansByName != null
      ? "read"
      : "assumed";
  const competitorLoansValue = bureauBlockAbsent ? 0 : competitorLoansByName ?? 0;
  conditions.push({
    id: 5,
    name: "no_competitor_loans",
    pass: bureauBlockAbsent || (competitorSource === "read" && competitorLoansValue === 0),
    value: competitorLoansValue,
    required: "0",
    source: competitorSource,
  });

  // 6. RiskSeal > 60
  //
  // The `?? 100` fallback made a fraud score nobody fetched read as a perfect
  // one. The value is left as-is so the failure line shows what the gate was
  // working from, but an unread score can no longer clear the bound.
  const risksealSource = provenanceOf(stage0Data.riskseal);
  const risksealScore = stage0Data.riskseal?.score ?? 100;
  conditions.push({
    id: 6,
    name: "riskseal_score",
    pass: risksealSource === "read" && risksealScore > 60,
    value: risksealScore,
    required: "> 60",
    source: risksealSource,
  });

  // 7. Sector safe
  //
  // `pass !== false` treats "never looked up" as "not high risk". A sector the
  // pipeline never resolved (no Firestore handle or no sectorCode — see
  // stage1-identity.js:96-103, which returns `{pass: true, skipped: true}`) is
  // an unknown sector, not a safe one.
  const sectorSource = provenanceOf(stage1Data.cnbv);
  const sectorSafe = stage1Data.cnbv?.pass !== false;
  conditions.push({
    id: 7,
    name: "sector_safe",
    pass: sectorSource === "read" && sectorSafe,
    value: stage1Data.cnbv?.riskLevel || "unknown",
    required: "not alto",
    source: sectorSource,
  });

  // 8. ML P(default) < MAX_PDEFAULT
  //
  // The explicit `!mlScore?.skipped` guard this condition already carried is
  // what `source === "read"` now says for all ten — it is the same test.
  //
  // ADR-005 Finding 5: this must read the CHAMPION model only — a `shadow:
  // true` challenger is logged, never obeyed (ADR-001). The response HAS
  // carried a champion/challenger split all along (`championScore` /
  // `challengerScore`); the note this comment replaced treated that shape as a
  // future hypothetical and read neither, which is how condition 8 came to
  // fail for every applicant. `deriveDefaultProbability` reads `championScore`
  // and only `championScore` — promoting a challenger into this gate is a
  // ratified event, not a response-shape change (ADR-001 §Decision.3).
  //
  // See `deriveDefaultProbability` above for the polarity (championScore is
  // P(repayment), so P(default) is its complement) and for why a null must
  // fail closed here rather than compare as NaN.
  const mlScore = stage2Data.mlScore;
  const mlSource = provenanceOf(mlScore);
  const pDefault = deriveDefaultProbability(mlScore);
  conditions.push({
    id: 8,
    name: "ml_default_prob",
    pass: mlSource === "read" && pDefault !== null && pDefault < maxPDefaultCutoff,
    value: pDefault,
    required: `< ${maxPDefaultCutoff}`,
    source: mlSource,
  });

  // 9. No active defaults
  //
  // Same block, same stub: a failed bureau call leaves `activeDefaults: 0`
  // behind. Zero defaults found on a report nobody read is not zero defaults.
  const activeDefaults = stage2Data.bureau?.activeDefaults || 0;
  conditions.push({
    id: 9,
    name: "no_active_defaults",
    pass: bureauSource === "read" && activeDefaults === 0,
    value: activeDefaults,
    required: "0",
    source: bureauSource,
  });

  // 10. Age 18-65
  const ageSource = stage1Data.age != null ? "read" : "assumed";
  const age = stage1Data.age || applicant.age;
  conditions.push({
    id: 10,
    name: "age_range",
    pass: ageSource === "read" && age >= 18 && age <= 65,
    value: age,
    required: "18-65",
    source: ageSource,
  });

  // 11. Bureau días de atraso == 0 — ADR-006 (2026-08-03). Reads the
  // bureau's own delinquency-days field directly (stage2-bureau.js plumbs
  // it from the bureau response). This SUPPLEMENTS condition 9's derived
  // count rather than replacing it: an earlier draft of this change retired
  // ids 9 and 10 in favour of 11/12, but retiring a condition LOOSENS the
  // gate (fewer conditions must hold ⇒ more auto-approvals), and that is a
  // commercial change nobody ratified. ADR-006 records the retirement as an
  // open question for Isaac; until he rules, the gate only tightens.
  // Same fail-closed shape as every other condition here: a bureau block
  // that ran but never carried this specific field reads as unread
  // (`diasAtrasoValue != null` on top of the block's own `source`), so an
  // outage cannot manufacture a clean value the way the error stub could.
  const diasAtrasoValue = stage2Data.bureau?.diasAtraso;
  const diasAtrasoSource = bureauSource === "read" && diasAtrasoValue != null ? "read" : "assumed";
  conditions.push({
    id: 11,
    name: "dias_atraso_zero",
    pass: diasAtrasoSource === "read" && diasAtrasoValue === 0,
    value: diasAtrasoValue ?? null,
    required: "0",
    source: diasAtrasoSource,
  });

  // 12. Bureau cartera vencida == false — ADR-006 (2026-08-03), the
  // bureau's own active-default flag, alongside dias_atraso_zero above.
  const carteraVencidaValue = stage2Data.bureau?.carteraVencida;
  const carteraVencidaSource = bureauSource === "read" && carteraVencidaValue != null ? "read" : "assumed";
  conditions.push({
    id: 12,
    name: "cartera_vencida_false",
    pass: carteraVencidaSource === "read" && carteraVencidaValue === false,
    value: carteraVencidaValue ?? null,
    required: "false",
    source: carteraVencidaSource,
  });

  return conditions;
}

async function runAutoApproveGate(applicant, allResults, { logger } = {}) {
  const log = logger || console;

  log.info({ stage: "stage3", rfc: applicant.rfc }, "Evaluating auto-approve gate");

  // Not caught here: `getMaxPDefault()` throwing (config doc unreadable or
  // untrustworthy) must fail this whole stage, not fall back to the seed.
  // decision-engine.js's try/catch around this call turns that into a Stage 5
  // (manual review) escalation — the same fail-closed shape as every other
  // condition below, extended to the cutoff itself.
  const maxPDefaultCutoff = await getMaxPDefault();
  const conditions = evaluateAutoApprove(applicant, allResults, maxPDefaultCutoff);
  const allPass = conditions.every(c => c.pass);
  const failedConditions = conditions.filter(c => !c.pass);

  const data = { conditions, allPass, failedConditions };

  if (allPass) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Auto-approved");
    return {
      pass: true,
      escalateToStage: null,
      reason: null,
      data,
      cost: [],
    };
  }

  // An escalation caused by data the pipeline never read is an outage, not a
  // credit judgement, and ops has to be able to size the two separately —
  // otherwise a provider going down looks like a sudden drop in applicant
  // quality. `source` already carries the distinction, so nothing new is
  // stored; it is only named in the log line that every escalation path below
  // shares.
  const unreadFailures = failedConditions.filter(c => c.source === "assumed").map(c => c.name);
  log.info(
    { stage: "stage3", rfc: applicant.rfc, failedConditions: failedConditions.map(c => c.name), unreadFailures },
    "Auto-approve gate failed"
  );

  // Determine escalation: Stage 4 or Stage 5
  const bureauScore = allResults.stage2?.data?.bureau?.score || 500;
  const activeDefaults = allResults.stage2?.data?.bureau?.activeDefaults || 0;
  const principalAmount = applicant.principalAmount || 0;

  // Stage 5 triggers: AML hits, score < 400, active defaults
  if (activeDefaults > 0 || bureauScore < 400) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Escalating to Stage 5 — manual review");
    return {
      pass: false,
      escalateToStage: 5,
      reason: "MANUAL_REVIEW_REQUIRED",
      data,
      cost: [],
    };
  }

  // Stage 4 triggers: > $2k, score 400-600, or Stage 3 fail
  if (principalAmount > 2000 || (bureauScore >= 400 && bureauScore <= 600)) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Escalating to Stage 4 — full KYC");
    return {
      pass: false,
      escalateToStage: 4,
      reason: "FULL_KYC_REQUIRED",
      data,
      cost: [],
    };
  }

  // Default: escalate to Stage 4
  return {
    pass: false,
    escalateToStage: 4,
    reason: "AUTO_APPROVE_FAILED",
    data,
    cost: [],
  };
}

module.exports = { runAutoApproveGate, evaluateAutoApprove, RETIRED_CONDITION_IDS };
