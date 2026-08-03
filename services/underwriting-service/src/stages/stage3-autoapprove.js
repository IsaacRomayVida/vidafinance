"use strict";
/**
 * Stage 3: Auto-Approve Gate
 *
 * 10 conditions ALL must pass:
 *   1. Employer tier >= 1 (not rejected)
 *   2. IMSS tenure > 6 months
 *   3. Bureau score > 600
 *   4. LTI <= 25%
 *   5. No competitor loans
 *   6. RiskSeal > 60
 *   7. Sector safe (CNBV not "alto")
 *   8. ML P(default) < MAX_PDEFAULT (champion model only)
 *   9. No active defaults
 *  10. Age 18-65 (already validated in Stage 1, re-checked here)
 *
 * 55% approved here. Cost: $21-47 MXN total pipeline.
 *
 * Every condition fails closed on data the pipeline never read (#458). A
 * condition passes only when its `source` is "read" AND its bound holds; an
 * "assumed" value can no longer clear a condition, so a provider outage
 * escalates to human review instead of quietly auto-approving. The single
 * documented exception is `no_competitor_loans` — see condition 5.
 */

// ADR-005 Finding 5: the cutoff used to be derived — `APPROVAL_THRESHOLD`
// (default 0.65), read as `pDefault < (1 - threshold)` — so raising something
// named "approval threshold" *loosened* credit. It is now declared directly.
// Value is commercial and UNCHANGED: 1 - 0.65 = 0.35, same as today.
const DEFAULT_MAX_PDEFAULT = 0.35;

function maxPDefault() {
  if (process.env.MAX_PDEFAULT != null) {
    return parseFloat(process.env.MAX_PDEFAULT);
  }
  // Legacy fallback: APPROVAL_THRESHOLD may already be set in a deployed
  // environment. A live env var that silently stops being read is a silent
  // credit-policy change, so it is still honoured — as `1 - threshold`, its
  // old meaning — until every environment is migrated to MAX_PDEFAULT.
  if (process.env.APPROVAL_THRESHOLD != null) {
    return 1 - parseFloat(process.env.APPROVAL_THRESHOLD);
  }
  return DEFAULT_MAX_PDEFAULT;
}

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

// ADR-005 Finding 6: stable numeric ids, alongside the names, for every
// condition below. Denial reasons derived from these conditions reach
// borrowers, and under the CONDUSEF regime a reason has to stay referenceable
// across a rename. Treat an id as permanent identity once assigned: never
// renumber or reassign an id to a different condition, even if the condition
// at that slot is later replaced (ADR-005 C4 governs which ten conditions
// gate — not this file). If a condition is retired, retire its id with it
// rather than recycling the number.
function evaluateAutoApprove(applicant, allResults) {
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

  // 5. No competitor loans — the one condition allowed to pass on a value the
  //    pipeline did not read, and only in one shape.
  //
  //    Every other condition tests a bound on a value we have to *obtain* — a
  //    score, a tenure, a tier — so absence of that value is ignorance and must
  //    fail closed. This one tests the absence of a finding in the applicant's
  //    account list. With no bureau block at all there is no account list
  //    either, and "no competitor accounts were found" is then literally true
  //    rather than assumed. It is safe to let that pass, not merely convenient:
  //    bureau_score and no_active_defaults read the same missing block and both
  //    now fail closed, and all ten conditions must hold, so a missing bureau
  //    can never be the margin between an outage and an approval. Failing this
  //    one as well would only restate a single root cause a third time in
  //    `failedConditions`. ADR-005 Finding 8 fixes exactly this as the
  //    acceptance criterion: all-null input yields 9 failures out of 10, with
  //    this the sole legitimate pass.
  //
  //    What must NOT pass is the bureau *error stub* (stage2-bureau.js:183-189),
  //    which fabricates `competitorLoans: 0` after a failed call. There a bureau
  //    file exists and we know we failed to read it, so the zero is invented
  //    rather than observed — unread, and it fails closed like the rest.
  const bureauBlockAbsent = stage2Data.bureau == null;
  const competitorLoans = stage2Data.bureau?.competitorLoans || 0;
  conditions.push({
    id: 5,
    name: "no_competitor_loans",
    pass: (bureauSource === "read" || bureauBlockAbsent) && competitorLoans === 0,
    value: competitorLoans,
    required: "0",
    source: bureauSource,
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
  // true` challenger is logged, never obeyed (ADR-001). `stage2Data.mlScore`
  // is the flat object `fetchMLScore` gets back from the ML service
  // (stage2-bureau.js) and carries no champion/challenger split today; it IS
  // the champion score. If the ML service response ever grows a
  // champion/challenger shape, this line must keep reading the champion only
  // — promoting a challenger into this gate is a ratified event, not a
  // fixture or response-shape change (ADR-001 §Decision.3).
  const mlScore = stage2Data.mlScore;
  const mlSource = provenanceOf(mlScore);
  const pDefault = mlScore?.default_probability || mlScore?.probability || (1 - (mlScore?.underwritingScore || 0.5));
  const cutoff = maxPDefault();
  conditions.push({
    id: 8,
    name: "ml_default_prob",
    pass: mlSource === "read" && pDefault < cutoff,
    value: pDefault,
    required: `< ${cutoff}`,
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

  return conditions;
}

async function runAutoApproveGate(applicant, allResults, { logger } = {}) {
  const log = logger || console;

  log.info({ stage: "stage3", rfc: applicant.rfc }, "Evaluating auto-approve gate");

  const conditions = evaluateAutoApprove(applicant, allResults);
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

module.exports = { runAutoApproveGate, evaluateAutoApprove };
